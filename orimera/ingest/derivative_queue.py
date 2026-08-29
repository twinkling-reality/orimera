"""The queue between the two halves of an ingest. It holds capture ids and never bytes.

**Why that is the whole design.** An upload has to put the photograph somewhere before the
pipeline can hash it, and there is nowhere safe to put it. An evidence address is a content hash
of the original bytes, a track key and a time interval; the bytes behind one live in the
content-addressed store, and the deletion cascade reaches exactly two things, the rows under the
nine tombstone guards and the objects in that store. Bytes staged anywhere else, a spool
directory or a queue payload or a scratch prefix, are reachable by neither. A tombstone written
while a file sits there finds nothing to cascade to, and every test of the cascade still passes,
because they look at the database and at the store. That is a deletion hole the suite is
structurally blind to, which is why the resolution is a shape rather than a sweep.

So the request thread runs the intake stage to completion, the bytes land in the store through
``committed_writes`` after the transaction that ran the tombstone guard commits, and what is
queued is the identifier of the capture that now owns them.

**A queued capture that is deleted before the worker runs is the ordinary path, not a hole.**
Migration 0011 refuses a derivative of tombstoned bytes, so the artifact row is refused and,
because the store write is deferred past the commit, the bytes are refused with it. The run is
cancelled rather than failed, and the orphan bytes left behind are the orphans any cancelled
ingest produces, in the store, which is the one place deletion reaches.

**There is no reclaim of a dead worker's row and this module does not pretend otherwise.**
:func:`claim` filters ``state = 'queued'`` and ``job_queue_idx`` is partial on the same
predicate, so a row stranded in ``running`` by a worker that died is invisible to every query
here. A reclaim written against this shape would not work, and half a reclaim reads as coverage.
What a real one needs is a heartbeat column the claimant updates, an index that can see
``running``, and a decision about how long is long enough, none of which is guessable. It is R20
on the defect register.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Final

import psycopg
from psycopg.types.json import Jsonb

__all__ = ["DERIVATIVES", "QueuedDerivatives", "claim", "enqueue", "finish"]

#: The ``job.kind`` of a queued derivative run. One string, in one place, because ``kind`` is
#: free text and a second spelling would be a queue nothing drains.
DERIVATIVES: Final = "intake_derivatives"


@dataclass(frozen=True, slots=True)
class QueuedDerivatives:
    """One claimed job: which batch it finishes and which captures it has left to process."""

    job_id: uuid.UUID
    batch_id: uuid.UUID | None
    capture_ids: tuple[uuid.UUID, ...]
    #: How many times this job has been claimed, including this one. Recorded rather than
    #: inferred, so a job that keeps failing says how often rather than looking like a new one.
    attempts: int


def enqueue(
    connection: psycopg.Connection,
    workspace_id: uuid.UUID,
    *,
    batch_id: uuid.UUID,
    capture_ids: list[uuid.UUID],
) -> uuid.UUID:
    """Queue the derivative stages for captures whose intake has already committed.

    Raises on an empty list rather than writing a job with nothing to do. A queued job is a
    promise that something is still coming, and a client watching a batch reads an open job as
    exactly that; one that will never produce an event is a stream that never ends.

    Called after the intakes commit, in the request that performed them. A process that dies in
    the window between the last intake and this insert returns no 202 either, so the client
    knows the upload did not complete; re-uploading the same bytes is free under content
    addressing and queues the work. That is the recovery, and it is the ordinary retry rather
    than a state anything has to repair.
    """
    if not capture_ids:
        raise ValueError("a derivative job needs at least one capture; queueing none is a lie")
    row = connection.execute(
        "insert into job (workspace_id, kind, payload, batch_id) values (%s, %s, %s, %s) "
        "returning job_id",
        (
            workspace_id,
            DERIVATIVES,
            Jsonb({"capture_ids": [str(capture_id) for capture_id in capture_ids]}),
            batch_id,
        ),
    ).fetchone()
    assert row is not None
    return row["job_id"]


def claim(
    connection: psycopg.Connection, workspace_id: uuid.UUID, *, worker: str
) -> QueuedDerivatives | None:
    """Take the next queued job for this workspace, or None when there is nothing to do.

    ``for update skip locked`` inside the subquery is what makes two workers safe: the second
    passes over the row the first is holding rather than blocking on it. The row is moved to
    ``running`` in the same statement, so a claim is never observable as a read that has not
    yet become a write.
    """
    row = connection.execute(
        "update job set state = 'running', claimed_by = %s, claimed_at = now(), "
        "  attempts = attempts + 1 "
        "where job_id = ("
        "  select job_id from job "
        "   where workspace_id = %s and kind = %s and state = 'queued' and run_after <= now() "
        "   order by priority, job_id for update skip locked limit 1) "
        "returning job_id, batch_id, payload, attempts",
        (worker, workspace_id, DERIVATIVES),
    ).fetchone()
    if row is None:
        return None
    payload = row["payload"] or {}
    return QueuedDerivatives(
        job_id=row["job_id"],
        batch_id=row["batch_id"],
        capture_ids=tuple(uuid.UUID(value) for value in payload.get("capture_ids", ())),
        attempts=row["attempts"],
    )


def finish(
    connection: psycopg.Connection,
    workspace_id: uuid.UUID,
    *,
    job_id: uuid.UUID,
    state: str,
    error: str | None = None,
) -> None:
    """Close a claimed job with what happened.

    ``done``, ``failed`` and ``cancelled`` are three different facts and the column already
    distinguishes them. ``cancelled`` is what a tombstone produces: the user deleted the
    photographs and the work stopped, which is the system working rather than a fault to retry.
    """
    if state not in ("done", "failed", "cancelled"):
        raise ValueError(f"a claimed job cannot be closed as {state!r}")
    connection.execute(
        "update job set state = %s, last_error = %s where job_id = %s and workspace_id = %s",
        (state, error, job_id, workspace_id),
    )

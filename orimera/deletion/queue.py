"""One claimed purge job, and the three ways it can end.

The queue is filled by a trigger in the tombstone's own transaction, not by this module and not
by any caller: migration 0013 section 5 says why. What is here is the reading half.

**``skipped`` is not terminal and that is the whole of correction 3.** A job whose bytes
something else still holds has not failed and is not done. It goes back, behind everything that
has not been tried, ordered by when it last was. Terminal ``skipped`` set
``tombstone.purge_completed_at`` while the photograph was still on disk, because the unique
constraint refused a second row for the same target and the completion check ignored it.

**There is no reclaim of a dead worker's ``running`` row.** :func:`claim_purge` filters on state
and ``purge_job_queue_idx`` is partial on the same, so a stranded row is invisible to every query
here. A reclaim written against this shape would not work and half a reclaim reads as coverage.
R20 on the defect register says what a real one needs. It is the same gap the derivative queue
has, and the same answer.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Final

import psycopg

__all__ = [
    "RETRY_AFTER",
    "PurgeTarget",
    "claim_purge",
    "finish_purge",
    "is_purge_complete",
    "mark_purged",
]

#: How long a skipped job waits before it is tried again. Long enough that a blob another live
#: capture holds is not re-examined every second, short enough that a deletion completes within
#: an hour of the last thing releasing it.
RETRY_AFTER: Final = dt.timedelta(minutes=15)


@dataclass(frozen=True, slots=True)
class PurgeTarget:
    """One stored object a tombstone asked to have destroyed."""

    purge_id: uuid.UUID
    tombstone_id: uuid.UUID
    workspace_id: uuid.UUID
    #: ``blob`` for an original, ``artifact`` for a derivative. The two are destroyed the same
    #: way and are recorded on different tables, which is the only reason this is here.
    target_kind: str
    #: The content hash, hex. **Not a storage key and not a path.** The store computes the key
    #: from the hash, so a queue row carrying a path would be a second opinion about where an
    #: object lives, and the one that is wrong is the one that leaves bytes behind.
    target_ref: str
    attempts: int
    #: What the store was told when it was told to destroy this. Every field is mandatory on
    #: PurgeAuthorization, and they come from the tombstone row rather than from a caller.
    requested_by: uuid.UUID
    reason: str | None


def claim_purge(
    connection: psycopg.Connection, workspace_id: uuid.UUID, *, worker: str
) -> PurgeTarget | None:
    """Take the next job for this workspace, or None when there is nothing to do.

    Picks up ``skipped`` as well as ``queued``, oldest attempt first and never-attempted before
    either, which is what makes ``skipped`` a state a job comes back from.
    """
    row = connection.execute(
        "update purge_job set state = 'running', attempts = attempts + 1, "
        "  attempted_at = now(), last_error = null "
        "where purge_id = ("
        "  select pj.purge_id from purge_job pj "
        "   where pj.workspace_id = %s "
        "     and (pj.state = 'queued' "
        "          or (pj.state = 'skipped' "
        "              and (pj.attempted_at is null or pj.attempted_at < now() - %s))) "
        "   order by pj.attempted_at nulls first, pj.created_at "
        "   for update skip locked limit 1) "
        "returning purge_id, tombstone_id, workspace_id, target_kind, target_ref, attempts",
        (workspace_id, RETRY_AFTER),
    ).fetchone()
    if row is None:
        return None
    tombstone = connection.execute(
        "select requested_by, reason from tombstone where tombstone_id = %s and workspace_id = %s",
        (row["tombstone_id"], workspace_id),
    ).fetchone()
    # The tombstone is what authorises the destruction and it is read here rather than carried on
    # the job, so a job cannot outlive the authorisation that produced it. `purge_job.tombstone_id`
    # is a NOT NULL foreign key, so this is a fact about the row rather than a branch that runs.
    assert tombstone is not None, f"purge job {row['purge_id']} names no tombstone"
    return PurgeTarget(
        purge_id=row["purge_id"],
        tombstone_id=row["tombstone_id"],
        workspace_id=row["workspace_id"],
        target_kind=row["target_kind"],
        target_ref=row["target_ref"],
        attempts=row["attempts"],
        requested_by=tombstone["requested_by"],
        reason=tombstone["reason"],
    )


def finish_purge(
    connection: psycopg.Connection,
    workspace_id: uuid.UUID,
    *,
    purge_id: uuid.UUID,
    state: str,
    error: str | None = None,
) -> None:
    """Close a claimed job as one of the three things that can have happened.

    ``done`` means the bytes are gone. ``skipped`` means something else still holds them and this
    will be asked again. ``failed`` means the attempt broke. Collapsing the middle one into
    either of the others is how ``purge_completed_at`` gets written over a photograph that is
    still there.
    """
    if state not in ("done", "skipped", "failed"):
        raise ValueError(f"a claimed purge job cannot be closed as {state!r}")
    connection.execute(
        "update purge_job set state = %s, last_error = %s, "
        "  completed_at = case when %s = 'done' then now() else null end "
        "where purge_id = %s and workspace_id = %s",
        (state, error, state, purge_id, workspace_id),
    )


def mark_purged(connection: psycopg.Connection, target: PurgeTarget) -> None:
    """Record that the bytes are gone, **after** they are gone.

    The order is the whole of it. The store is not in this transaction, so a row marked purged
    before the object is destroyed is a row that lies when the process dies in between, and it
    lies in the direction that stops anything ever trying again. Destroyed first, recorded
    second: a crash in that window leaves a job that is re-claimed and a `purge` that returns
    False because the object is already absent, which is why erasure is idempotent.

    ``storage_key`` is cleared with the same statement. 0001 keeps the stub row so a citation
    into deleted content resolves to "the user deleted this" rather than to nothing; a stub still
    pointing at an object key would be pointing at something that is not there.
    """
    if target.target_kind == "blob":
        connection.execute(
            "update blob set purged_at = now(), storage_key = null "
            "where blob_sha256 = decode(%s, 'hex') and purged_at is null",
            (target.target_ref,),
        )
        return
    connection.execute(
        "update artifact set purged_at = now(), storage_key = null "
        "where workspace_id = %s and content_sha256 = decode(%s, 'hex') and purged_at is null",
        (target.workspace_id, target.target_ref),
    )


def is_purge_complete(
    connection: psycopg.Connection, tombstone_id: uuid.UUID
) -> bool:
    """Did the deletion happen, rather than did the queue go quiet. Correction 4."""
    row = connection.execute(
        "select tombstone_purge_is_complete(%s) as complete", (tombstone_id,)
    ).fetchone()
    assert row is not None
    return bool(row["complete"])

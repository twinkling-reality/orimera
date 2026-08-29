"""The intake batch: what a person means when they say "my photographs are uploading".

This schema's ``capture`` is one photograph and ``pipeline_run`` is one run over one photograph.
Neither is the thing a visitor watches form. ``interaction-model.md`` section 8 describes someone
watching 148 photographs become one region, and until migration 0003 the only record that those
photographs arrived together was that their runs happened to be adjacent in time.

Three properties are decisions rather than bookkeeping.

**The declared size is NULL until the source has been counted.** Enumerating a directory takes
time, and a total handed over before one exists is a denominator nobody measured. The front end
was built so that an unknown total is representable as absent rather than as a lie, and this is
the server side of that: :meth:`IntakeBatch.declare_size` is a separate call, made after the walk,
and everything before it honestly reports no total.

**A batch is closed with what happened, not with what was hoped.** ``succeeded``, ``partial`` and
``failed`` are three different outcomes and the middle one is not an error state:
``interaction-model.md`` 8.3 says failure leaves the partial region in place and that partial
usability is the point.

**Nothing here can be cited.** A batch has no blob, no clock anchor and no evidence address, and
it must never gain one. An evidence address is a content hash, a track key and a time interval;
a batch id is a handle for watching work happen and is expected to be useless afterwards.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Final

from orimera.ingest.repository import IngestRepository

__all__ = ["BATCH_STATUSES", "IntakeBatch"]

#: The closed set the column checks. ``partial`` is a first-class outcome and not a failure.
BATCH_STATUSES: Final[tuple[str, ...]] = (
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
)


@dataclass(frozen=True, slots=True)
class IntakeBatch:
    """One watched intake. Open it, declare its size once it is known, close it with the truth."""

    repository: IngestRepository
    batch_id: uuid.UUID

    @classmethod
    def open(cls, repository: IngestRepository, *, label: str | None = None) -> IntakeBatch:
        """Start a batch. Its size is unknown at this point and is recorded as unknown."""
        row = repository.connection.execute(
            "insert into intake_batch (workspace_id, label) values (%s, %s) returning batch_id",
            (repository.workspace_id, label),
        ).fetchone()
        assert row is not None
        return cls(repository=repository, batch_id=row["batch_id"])

    def declare_size(self, size: int) -> None:
        """Record how many photographs the source turned out to contain.

        Called once, after the source has been enumerated. Declaring it twice with different
        numbers would mean the total moved under a client that had already rendered it, so the
        column is written and not accumulated.
        """
        if size < 0:
            raise ValueError("a batch cannot contain a negative number of photographs")
        self.repository.connection.execute(
            "update intake_batch set declared_size = %s where batch_id = %s and workspace_id = %s",
            (size, self.batch_id, self.repository.workspace_id),
        )

    def close(self, status: str) -> bool:
        """Close a running batch. False when it was already closed and nothing was written.

        **A closed batch is not reopened, and that is a guard rather than tidiness.** A batch's
        terminal event is what ends a formation stream, so a second close writes a second
        terminal event: measured with two workers and no claim token, one wrote ``succeeded`` and
        the other rewrote the same batch as ``failed`` with a fresh ``ended_at`` 4.5 seconds
        later, after the subscriber's stream had already ended on the first. The queue's claim
        token is what stops a worker reaching here without the right to; this is the second guard,
        and it holds for any caller rather than only for the one that holds a lease.
        """
        if status not in BATCH_STATUSES or status == "running":
            raise ValueError(f"a batch cannot be closed as {status!r}")
        updated = self.repository.connection.execute(
            "update intake_batch set status = %s, ended_at = now() "
            "where batch_id = %s and workspace_id = %s and status = 'running'",
            (status, self.batch_id, self.repository.workspace_id),
        )
        return updated.rowcount == 1

    @staticmethod
    def outcome_for(succeeded: int, failed: int) -> str:
        """Which of the three outcomes a finished batch had.

        A batch of nothing is ``succeeded`` rather than ``failed``: an empty directory is not an
        error, and reporting it as one would send a visitor looking for a fault that is a folder
        with nothing in it.
        """
        if failed == 0:
            return "succeeded"
        return "failed" if succeeded == 0 else "partial"

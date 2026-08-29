"""The worker that finishes an upload: rendition, vision, depth, scenes, proposals.

**It does not import the API and it must not start.** ``orimera.ingest`` sits under
``orimera.api`` in the layers contract, so a worker reaching for
``orimera.api.authorisation`` to find out which workspaces exist inverts the layering, and
``uv run lint-imports`` says so. It takes the workspaces as a value instead. The application
knows them because they came from its token directory, and passing them down is one argument
rather than a dependency.

**What runs here and what does not.** The vision stage is a model call and belongs nowhere near
a request thread. The intake stage is a hash, an EXIF read, an orientation transform and a few
rows, and it has already happened by the time a job is claimed: see
:mod:`orimera.ingest.derivative_queue` for why the split is where it is. So this drains capture
ids, computes derivatives from bytes already in the content-addressed store, and closes the
batch that was watching.

**The batch is closed here rather than by the request**, because a batch's terminal event is what
tells a client to stop listening and it has to come after all the work. A request that closed the
batch it opened would emit "finished" while the vision stage had not started.

**Scene grouping and match proposals run at the end of a job**, through
:func:`orimera.ingest.continuity.run_continuity`, which is the same call ``orimera-ingest`` makes
at the end of a directory. Inside the batch, so continuity search appears in the formation stream
as the stage it is: left out, a watched upload would stop after entity indexing and finish with
no account of the gap.

**One thread, and it says so.** This is a synchronous worker over a synchronous driver, polling
one indexed query. That is right for a demonstration with one person uploading, and it is not a
job system: there is no reclaim of a dead worker's row, no backoff schedule and no dead-letter
queue. The first of those is R20 on the defect register with what a real one needs.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Final

from orimera.db.session import Database
from orimera.ingest import derivative_queue
from orimera.ingest.batch import IntakeBatch
from orimera.ingest.continuity import run_continuity
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.ingest.repository import IngestRepository
from orimera.ingest.vision import VisionModel
from orimera.reconstruction import DepthModel
from orimera.store.base import ContentAddressedStore

__all__ = ["DerivativeWorker", "JobOutcome"]

#: How often an idle worker asks again. Slow enough that an idle instance costs one cheap
#: indexed query per workspace every two seconds, fast enough that an upload's remaining stages
#: begin while the person who uploaded it is still watching.
_POLL_SECONDS: Final = 2.0


@dataclass
class JobOutcome:
    """What one claimed job did, for a caller that drains synchronously and wants to know."""

    job_id: uuid.UUID
    batch_id: uuid.UUID | None
    succeeded: int = 0
    failed: int = 0
    cancelled: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def captures(self) -> int:
        return self.succeeded + self.failed + self.cancelled


class DerivativeWorker:
    """Drains the derivative queue for a fixed set of workspaces."""

    def __init__(
        self,
        database: Database,
        store: ContentAddressedStore,
        workspaces: frozenset[uuid.UUID],
        *,
        vision: VisionModel | None = None,
        depth: DepthModel | None = None,
        name: str = "derivatives",
        poll_seconds: float = _POLL_SECONDS,
    ) -> None:
        self._database = database
        self._store = store
        self._workspaces = workspaces
        self._vision = vision
        self._depth = depth
        self._name = name
        self._poll_seconds = poll_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # -- driving it ---------------------------------------------------------------------

    def drain(self) -> list[JobOutcome]:
        """Claim and run every job that is queued right now, then return. Never raises.

        This is the whole of the worker's work, factored out of the loop so that a test drives
        it directly rather than starting a thread and waiting. A thread that has to be waited on
        is a test that is slow when it passes and flaky when it does not.
        """
        outcomes: list[JobOutcome] = []
        for workspace_id in sorted(self._workspaces):
            while not self._stop.is_set():
                outcome = self._claim_one(workspace_id)
                if outcome is None:
                    break
                outcomes.append(outcome)
        return outcomes

    def start(self) -> None:
        """Run the loop on a daemon thread. Idempotent."""
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name=self._name, daemon=True)
        self._thread.start()

    def stop(self, *, timeout: float = 10.0) -> None:
        """Ask the loop to finish the job it is on and stop. Idempotent."""
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.drain()
            # Waiting on the event rather than sleeping, so stop() is immediate rather than up
            # to one poll interval late. A shutdown that takes two seconds per worker is a
            # deployment that looks hung.
            self._stop.wait(self._poll_seconds)

    # -- one job ------------------------------------------------------------------------

    def _claim_one(self, workspace_id: uuid.UUID) -> JobOutcome | None:
        """Claim one job and run it. Returns None when the queue for this workspace is empty.

        A failure inside the job is recorded on the job row and on the batch, and does not
        propagate: a worker that dies on one bad photograph stops draining every other upload in
        the instance, which is a much worse failure than the one it is reacting to.
        """
        with self._database.session(workspace_id) as connection:
            repository = IngestRepository(connection, workspace_id)
            claimed = derivative_queue.claim(connection, workspace_id, worker=self._name)
            if claimed is None:
                return None
            outcome = JobOutcome(job_id=claimed.job_id, batch_id=claimed.batch_id)
            try:
                self._run_job(repository, claimed, outcome)
            except Exception as exc:
                outcome.errors.append(f"{type(exc).__name__}: {exc}")
                derivative_queue.finish(
                    connection,
                    workspace_id,
                    job_id=claimed.job_id,
                    state="failed",
                    error="; ".join(outcome.errors)[:2000],
                )
                self._close_batch(repository, claimed.batch_id, outcome)
                return outcome
            derivative_queue.finish(
                connection,
                workspace_id,
                job_id=claimed.job_id,
                # Every capture refused because the user deleted it is not a failure: it is the
                # deletion path working. A job that was entirely deletions is cancelled, which
                # is a third fact and the column already has a word for it.
                state=self._job_state(outcome),
                error="; ".join(outcome.errors)[:2000] or None,
            )
            self._close_batch(repository, claimed.batch_id, outcome)
            return outcome

    def _run_job(
        self,
        repository: IngestRepository,
        claimed: derivative_queue.QueuedDerivatives,
        outcome: JobOutcome,
    ) -> None:
        pipeline = PhotoIngestPipeline(
            repository, self._store, vision=self._vision, depth=self._depth
        )
        for capture_id in claimed.capture_ids:
            result = pipeline.ingest_derivatives(capture_id, batch_id=claimed.batch_id)
            if result.tombstoned:
                outcome.cancelled += 1
            elif result.error is not None:
                outcome.failed += 1
                outcome.errors.append(f"{capture_id}: {result.error}")
            else:
                outcome.succeeded += 1

        # The whole corpus, once, rather than per photograph: continuity is a relation between
        # captures and cannot be computed from one. Inside the batch so it appears in the
        # formation stream as the stage it is. The same call `orimera-ingest` makes at the end
        # of a directory, and the same one, so the two cannot drift.
        run_continuity(repository, batch_id=claimed.batch_id)

    @staticmethod
    def _job_state(outcome: JobOutcome) -> str:
        if outcome.failed:
            return "failed"
        if outcome.cancelled and not outcome.succeeded:
            return "cancelled"
        return "done"

    @staticmethod
    def _close_batch(
        repository: IngestRepository, batch_id: uuid.UUID | None, outcome: JobOutcome
    ) -> None:
        """Close the watched intake with what happened, which is what ends the stream.

        A capture the user deleted mid-flight counts as neither succeeded nor failed here: it
        was withdrawn. Counting it as a failure would put a red state in front of somebody who
        had just pressed delete and got exactly what they asked for, and the terminal event
        already tells the truth about what is left: ``photographsAvailable`` counts live
        captures, so a batch whose every photograph was deleted ends as ready with none.
        """
        if batch_id is None:
            return
        IntakeBatch(repository=repository, batch_id=batch_id).close(
            IntakeBatch.outcome_for(succeeded=outcome.succeeded, failed=outcome.failed)
        )

"""The provenance ledger. The Assembly Replay is generated from this and from nothing else.

The rule that shapes every line here: **anything not recorded in the ledger can never be shown
to a user.** A replay that reconstructs the DAG from the shape of the source code lies as soon
as the source changes, and it lies most convincingly about old runs, so ``input_artifact_ids``
is recorded explicitly on ``stage_started`` even when the calling code obviously knows them.

The second rule: **do not record anything you cannot measure.** Token counts come from the
provider's own ``usage`` object, durations from a monotonic clock, retries from the attempt
counter that actually drove the loop. There is no field here holding a plausible number.
"""

from __future__ import annotations

import datetime as dt
import platform
import time
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from psycopg.types.json import Jsonb

from orimera.evidence.blob import BlobId
from orimera.ingest.repository import IngestRepository
from orimera.ingest.stages import StageSpec

__all__ = ["Ledger", "StageRecorder"]


def _now() -> dt.datetime:
    """The one clock this module reads. Connections are pinned to UTC, so is this."""
    return dt.datetime.now(dt.UTC)


@dataclass
class StageRecorder:
    """Collects what a stage did, so the closing event states facts rather than intentions."""

    ledger: Ledger
    spec: StageSpec
    started_at: dt.datetime
    started_monotonic: float
    input_artifact_ids: list[uuid.UUID]
    input_blob: BlobId | None
    stage_started_event: uuid.UUID
    output_artifact_ids: list[uuid.UUID] = field(default_factory=list)
    model_ref: dict[str, Any] | None = None
    cost: dict[str, Any] | None = None
    attempt: int = 1
    reused: bool = False

    def record_output(self, artifact_id: uuid.UUID) -> None:
        """Note an artifact this stage produced, and emit ``artifact_written``.

        The content hash is deliberately not repeated in the event. It lives on the artifact
        row, which the replay already joins to for clickable outputs, and a second copy is a
        second thing that can disagree with the first.
        """
        self.output_artifact_ids.append(artifact_id)
        self.ledger.event(
            "artifact_written",
            stage=self.spec,
            parent_event_id=self.stage_started_event,
            output_artifact_ids=[artifact_id],
            input_blob=self.input_blob,
        )

    def record_model_call(
        self, model_ref: dict[str, Any], cost: dict[str, Any], attempts: int
    ) -> None:
        self.model_ref = model_ref
        self.cost = cost
        self.attempt = attempts

    def record_retry(self, attempt: int, error_class: str, message: str) -> None:
        self.ledger.event(
            "retry_scheduled",
            stage=self.spec,
            parent_event_id=self.stage_started_event,
            attempt=attempt,
            error_class=error_class,
            error_message=message,
            input_blob=self.input_blob,
        )

    def record_nondeterminism(self, expected: bytes, actual: bytes) -> None:
        """Same idempotency key, different bytes, on a stage that claims to be deterministic.

        Informational rather than fatal, and it carries **both** hashes, because the useful
        question afterwards is which one the existing citations point at. The stored artifact
        is never overwritten, so the answer is always ``expected``.
        """
        self.ledger.event(
            "nondeterminism_detected",
            stage=self.spec,
            parent_event_id=self.stage_started_event,
            input_blob=self.input_blob,
            error_class="nondeterminism_detected",
            error_message=f"kept sha-256 {expected.hex()}, recomputed to {actual.hex()}",
        )


class Ledger:
    """One pipeline run and its gapless event stream."""

    def __init__(self, repository: IngestRepository, run_id: uuid.UUID) -> None:
        self._repository = repository
        self._db = repository.connection
        self.run_id = run_id
        self._host = platform.node() or "unknown"

    @classmethod
    def start_run(
        cls,
        repository: IngestRepository,
        *,
        trigger: str,
        capture_id: uuid.UUID | None = None,
        pipeline_digest: str | None = None,
    ) -> Ledger:
        row = repository.connection.execute(
            'insert into pipeline_run (workspace_id, capture_id, "trigger", status) '
            "values (%s, %s, %s, 'running') returning run_id",
            (repository.workspace_id, capture_id, trigger),
        ).fetchone()
        assert row is not None
        run_id = row["run_id"]
        ledger = cls(repository, run_id)
        # The pipeline digest goes in params_digest, which is the column for "the parameters
        # this was executed under". At run level that is exactly what it is.
        ledger.event(
            "run_started",
            params_digest=bytes.fromhex(pipeline_digest) if pipeline_digest else None,
        )
        return ledger

    def attach_capture(self, capture_id: uuid.UUID) -> None:
        """Link the run to its capture once the capture row exists.

        The run is opened before the capture is registered, so the very first event of an
        ingest is inside the run rather than before it. ``pipeline_run`` already carries
        mutable status and end-time columns, so setting the capture here is consistent with how
        that table is used: the append-only surface is ``pipeline_event``, not this row.
        """
        self._db.execute(
            "update pipeline_run set capture_id = %s where run_id = %s",
            (capture_id, self.run_id),
        )

    def _next_seq(self) -> int:
        row = self._db.execute(
            "select coalesce(max(seq), 0) as top from pipeline_event where run_id = %s",
            (self.run_id,),
        ).fetchone()
        assert row is not None
        return int(row["top"]) + 1

    def event(
        self,
        event_type: str,
        *,
        stage: StageSpec | None = None,
        parent_event_id: uuid.UUID | None = None,
        input_artifact_ids: Sequence[uuid.UUID] = (),
        output_artifact_ids: Sequence[uuid.UUID] = (),
        input_blob: BlobId | None = None,
        model_ref: dict[str, Any] | None = None,
        cost: dict[str, Any] | None = None,
        params_digest: bytes | None = None,
        attempt: int = 1,
        max_attempts: int | None = None,
        error_class: str | None = None,
        error_message: str | None = None,
        started_at: dt.datetime | None = None,
        ended_at: dt.datetime | None = None,
        duration_ms: int | None = None,
    ) -> uuid.UUID:
        """Append one event. ``seq`` is gapless per run."""
        row = self._db.execute(
            "insert into pipeline_event (run_id, seq, parent_event_id, type, "
            "stage_key, stage_version, model_ref, params_digest, input_artifact_ids, "
            "output_artifact_ids, input_blob_sha256, attempt, max_attempts, error_class, "
            "error_message, started_at, ended_at, duration_ms, cost, host) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, %s::uuid[], %s::uuid[], %s, %s, %s, %s, "
            "%s, %s, %s, %s, %s, %s) returning event_id",
            (
                self.run_id,
                self._next_seq(),
                parent_event_id,
                event_type,
                stage.key if stage else None,
                stage.version if stage else None,
                Jsonb(model_ref) if model_ref else None,
                params_digest
                if params_digest is not None
                else (stage.params_digest if stage else None),
                list(input_artifact_ids),
                list(output_artifact_ids),
                input_blob.digest if input_blob else None,
                attempt,
                max_attempts,
                error_class,
                error_message[:2000] if error_message else None,
                started_at,
                ended_at,
                duration_ms,
                Jsonb(cost) if cost else None,
                self._host,
            ),
        ).fetchone()
        assert row is not None
        return row["event_id"]

    @contextmanager
    def stage(
        self,
        spec: StageSpec,
        *,
        input_artifact_ids: Sequence[uuid.UUID] = (),
        input_blob: BlobId | None = None,
    ) -> Iterator[StageRecorder]:
        """Bracket a stage with ``stage_started`` and one of ``stage_succeeded``/``stage_failed``.

        ``input_artifact_ids`` is mandatory on ``stage_started`` in the sense that it is always
        written, including as an empty list for a source stage. An empty list is a fact; an
        absent field is an unanswerable question.
        """
        started_at = _now()
        started_monotonic = time.monotonic()
        stage_started = self.event(
            "stage_started",
            stage=spec,
            input_artifact_ids=input_artifact_ids,
            input_blob=input_blob,
            started_at=started_at,
        )
        recorder = StageRecorder(
            ledger=self,
            spec=spec,
            started_at=started_at,
            started_monotonic=started_monotonic,
            input_artifact_ids=list(input_artifact_ids),
            input_blob=input_blob,
            stage_started_event=stage_started,
        )
        try:
            yield recorder
        except BaseException as exc:
            self.event(
                "stage_failed",
                stage=spec,
                parent_event_id=stage_started,
                input_artifact_ids=input_artifact_ids,
                output_artifact_ids=recorder.output_artifact_ids,
                input_blob=input_blob,
                model_ref=recorder.model_ref,
                cost=recorder.cost,
                attempt=recorder.attempt,
                error_class=type(exc).__name__,
                error_message=str(exc),
                started_at=started_at,
                ended_at=_now(),
                duration_ms=int((time.monotonic() - started_monotonic) * 1000),
            )
            raise
        self.event(
            "stage_succeeded",
            stage=spec,
            parent_event_id=stage_started,
            input_artifact_ids=input_artifact_ids,
            output_artifact_ids=recorder.output_artifact_ids,
            input_blob=input_blob,
            model_ref=recorder.model_ref,
            cost=recorder.cost,
            attempt=recorder.attempt,
            started_at=started_at,
            ended_at=_now(),
            duration_ms=int((time.monotonic() - started_monotonic) * 1000),
        )

    def emitted(self, kind: str, ids: Sequence[uuid.UUID], stage: StageSpec) -> None:
        """Record that assertions or proposals were written, and how many.

        The ids go in ``output_artifact_ids`` because that is the array the schema indexes for
        replay. They are assertion and derived-artifact ids rather than artifact ids, and the
        event type says which.
        """
        if not ids:
            return
        self.event(
            "assertion_emitted" if kind == "assertion" else "proposal_emitted",
            stage=stage,
            output_artifact_ids=ids,
        )

    def finish(self, status: str) -> None:
        self.event(f"run_{status}")
        self._db.execute(
            "update pipeline_run set status = %s, ended_at = now() where run_id = %s",
            (status, self.run_id),
        )

    # -- replay -------------------------------------------------------------------------

    def replay(self) -> list[dict[str, Any]]:
        """The Assembly Replay for this run: the event stream in order, as plain dicts."""
        rows = self._db.execute(
            "select * from pipeline_event where run_id = %s order by seq", (self.run_id,)
        ).fetchall()
        return [dict(row) for row in rows]

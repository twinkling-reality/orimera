"""The photograph ingest pipeline: a file on disk to persisted, provenance-tracked observations.

Four stages, each one idempotent by construction and each one a module in ``stages/``:

    intake     hash the bytes, read EXIF, normalise orientation, register the capture, the
               single-sample img track, the wall-clock anchor and the whole-image span, and
               emit the capture-supported assertions
    rendition  a 768 px display-space JPEG with no EXIF, the only pixels a model ever sees
    vision     one structured call, producing model inferences that each carry an evidence
               address and are filed as inference and never as anything else
    scene      time and GPS clustering across captures, producing PROPOSALS (see scenes.py)

This module sequences them and owns the two things they share: the transaction whose object
store writes land after it commits, and the artifact writer. What a stage is allowed to reach
for is ``stages.writes.StageWrites``, which this class satisfies; it holds several other things
a stage has no business touching, and the Protocol is where that line is drawn.

Re-running is free. Every derivative is keyed by ``(source blob, stage, stage version, params,
input digest, run-time binding)``, so a second run over the same directory resolves each stage
from its artifact row and makes **zero** model calls. That is a cost control first and a
correctness control second: without it, "re-run everything" means paying for every vision call
again, every time. It cuts the other way too, and has to: the vision stage's params carry the
prompt's own digest and its binding carries the resolved model identifier, so editing the
prompt or swapping the model does reprocess, which is the failure this key is most likely to
hide.

Nothing reaches the object store until the tombstone guard has passed and the transaction that
passed it has committed. The store is not in the transaction, so a byte written early is a byte
a rollback cannot take back, and for purged content that means resurrection.

The epistemic split is enforced at the data layer, not by care here. ``predicate.allows_kind``
refuses a caption filed as a capture-supported fact and refuses any name at all from a model.
"""

from __future__ import annotations

import io
import uuid
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Final

from PIL import Image, UnidentifiedImageError

from orimera.canonical import sha256_digest
from orimera.errors import TombstonedError
from orimera.evidence import EvidenceAddress
from orimera.evidence.blob import BlobId
from orimera.ingest.batch import IntakeBatch
from orimera.ingest.exif import extract_exif_facts
from orimera.ingest.ledger import Ledger, StageRecorder
from orimera.ingest.report import IngestOutcome, IngestReport
from orimera.ingest.repository import IngestRepository
from orimera.ingest.stages import (
    STAGES,
    StageSpec,
    artifact_id_for,
    pipeline_digest,
)
from orimera.ingest.stages import depth as depth_stage
from orimera.ingest.stages import intake as intake_stage
from orimera.ingest.stages import rendition as rendition_stage
from orimera.ingest.stages import vision as vision_stage
from orimera.ingest.stages.writes import StageResult
from orimera.ingest.vision import VisionModel
from orimera.reconstruction import DepthModel
from orimera.store.base import ContentAddressedStore

__all__ = ["SUPPORTED_SUFFIXES", "PhotoIngestPipeline"]

SUPPORTED_SUFFIXES: Final = frozenset({".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"})


class PhotoIngestPipeline:
    """Ingest photographs into the evidence spine.

    ``vision`` is optional. With no vision model the pipeline still produces a complete
    capture-supported record: hash, EXIF, orientation, timing, position, dimensions, the track,
    the span and the assertions. The vision stage is then reported as not run rather than
    faked, and a later run with a model configured completes it.
    """

    def __init__(
        self,
        repository: IngestRepository,
        store: ContentAddressedStore,
        *,
        vision: VisionModel | None = None,
        depth: DepthModel | None = None,
    ) -> None:
        self._repository = repository
        self._store = store
        self._vision = vision
        self._depth = depth
        # The run-time half of every stage's identity, resolved once. For the vision stage that
        # is the identifier the model role points at right now: it is not in the registry
        # because it does not live in the source, and it is in the key because swapping it
        # changes what the stage produces.
        self._bindings: dict[str, dict[str, str]] = {}
        if vision is not None:
            self._bindings["vision"] = {"model_id": vision.model_id}
        if depth is not None:
            # The resolved model is in the key for the same reason the vision model is: swapping
            # the weights changes what the stage produces, and a corpus keyed as though nothing
            # had changed would never reprocess.
            self._bindings["depth"] = {"model_id": depth.model_id}
        repository.register_stages(STAGES)

    @property
    def pipeline_digest(self) -> str:
        """This pipeline's version, prompt text and resolved models, as one short digest."""
        return pipeline_digest(self._bindings)

    # -- what a stage is given ------------------------------------------------------------

    @property
    def repository(self) -> IngestRepository:
        return self._repository

    @property
    def store(self) -> ContentAddressedStore:
        return self._store

    def _binding_for(self, spec: StageSpec) -> dict[str, str] | None:
        return self._bindings.get(spec.key)

    @contextmanager
    def committed_writes(self) -> Iterator[list[bytes]]:
        """A database transaction whose object-store writes happen **after** it commits.

        The store is not transactional and cannot be enrolled in one, so a payload written
        inside a transaction survives that transaction's rollback. Two consequences, one of
        them serious:

        *   A tombstoned import is cancelled and its rows roll back, and the purged bytes are
            back on disk. Deletion that a retry undoes is not deletion.
        *   An ordinary stage failure leaves an orphan object nothing references.

        Deferring the write past the commit inverts the failure mode into the recoverable one:
        a crash in the window between commit and flush leaves a row whose bytes are missing,
        which ``persist_artifact`` and the rendition stage already detect and heal by
        recomputing. No compensating cleanup is needed, because nothing was written that would
        need cleaning up; ordering genuinely is sufficient here, which is why it is done by
        ordering.

        ``tests/test_ingest_persistence.py`` walks the whole ingest package, recursively, and
        asserts this is the only function in it that writes to the store.
        """
        pending: list[bytes] = []
        with self._repository.transaction():
            yield pending
        for payload in pending:
            self._store.put_bytes(payload)

    def persist_artifact(
        self,
        *,
        spec: StageSpec,
        blob_id: BlobId,
        key: str,
        input_digest: bytes,
        payload: bytes,
        recorder: StageRecorder,
        outcome: IngestOutcome,
        pending: list[bytes],
        produced_by_event: uuid.UUID | None = None,
    ) -> StageResult:
        """Queue bytes, insert the artifact row, and report reuse honestly.

        Bytes go on ``pending`` rather than into the store, and reach the store only once the
        surrounding transaction has committed. See ``committed_writes``.

        The two hashes are kept apart on purpose. ``idempotency_key`` is what the output should
        be, computed before running. ``content_sha256`` is what it turned out to be. When a
        deterministic stage produces different content under the same key, that is worth an
        event rather than a silent overwrite, and the existing artifact is kept: mutating it
        would break every citation and every replay that already points at it.

        This is also the single place a stage is recorded as run or reused. A stage that
        appends to ``outcome`` itself as well as calling this is how "depth+depth" reached the
        command line summary.
        """
        content_hash = sha256_digest(payload)
        existing = self._repository.find_artifact(key)
        if existing is not None:
            stored = existing.content_sha256 or content_hash
            if existing.content_sha256 is not None and existing.content_sha256 != content_hash:
                # Same key, different bytes. For a stage declared deterministic that is a fault
                # worth an event; for a sampled one it is expected. Either way the stored
                # artifact wins, because citations and replays already point at it.
                if spec.deterministic:
                    recorder.record_nondeterminism(existing.content_sha256, content_hash)
                if not self._store.exists(BlobId(stored)):
                    # The bytes are gone and this run cannot reproduce them. Flag it rather
                    # than repointing the row at the new bytes: the identity key names the old
                    # content, and redefining what it names would silently invalidate every
                    # citation and replay that used it.
                    self._repository.mark_artifact_needs_repair(existing.artifact_id)
            elif not self._store.exists(BlobId(stored)):
                # The row survived but the bytes did not, and the recompute matched. Heal
                # rather than fail: the artifact identity is unchanged, so nothing downstream
                # has to be told.
                pending.append(payload)
            outcome.stages_reused.append(spec.key)
            return StageResult(
                artifact_id=existing.artifact_id,
                content_sha256=stored,
                idempotency_key=key,
                reused=True,
            )
        pending.append(payload)
        artifact_id = artifact_id_for(key)
        self._repository.insert_artifact(
            artifact_id=artifact_id,
            kind=spec.output_kind,
            source_blob=blob_id,
            stage_key=spec.key,
            stage_version=spec.version,
            params_digest=spec.params_digest,
            input_digest=input_digest,
            idempotency_key=key,
            content_sha256=content_hash,
            storage_key=self._store.key_for(BlobId(content_hash)),
            byte_size=len(payload),
            produced_by_event=produced_by_event,
        )
        recorder.record_output(artifact_id)
        outcome.stages_run.append(spec.key)
        return StageResult(
            artifact_id=artifact_id,
            content_sha256=content_hash,
            idempotency_key=key,
            reused=False,
        )

    # -- directory ----------------------------------------------------------------------

    def ingest_directory(
        self,
        directory: str | Path,
        *,
        recursive: bool = True,
        limit: int | None = None,
        batch: IntakeBatch | None = None,
    ) -> IngestReport:
        """Ingest every supported image under ``directory``. Safe to run repeatedly.

        ``batch`` is a watched intake to run inside, and this method JOINS it rather than owning
        it. The distinction is not tidiness. A batch's terminal event is what tells the interface
        the work is over and lets a client stop listening, so it has to come after all of the
        work; and this method is not all of the work, because continuity search runs over the
        whole corpus once the photographs are in. A pipeline that closed the batch it opened
        would emit "finished" and then carry on emitting stages into a stream nobody was reading.

        What it does own is the declaration of size, because it is what walks the directory. The
        order matters: the batch exists before the walk so a client can subscribe to something
        that honestly reports no total, and the total is written once, from what the walk found,
        rather than accumulated as it goes. A denominator that grows is one that moves under a
        fraction somebody is already reading.
        """
        report = IngestReport(pipeline_digest=self.pipeline_digest)
        report.batch_id = batch.batch_id if batch else None

        paths = list(_iter_images(Path(directory), recursive=recursive))
        if limit is not None:
            paths = paths[:limit]
        if batch is not None:
            batch.declare_size(len(paths))

        for path in paths:
            report.outcomes.append(self.ingest_file(path, batch_id=report.batch_id))
        return report

    # -- one file -----------------------------------------------------------------------

    def ingest_file(
        self, path: str | Path, *, batch_id: uuid.UUID | None = None
    ) -> IngestOutcome:
        """Ingest one photograph. Never raises for a bad file: the outcome carries the error."""
        source = Path(path)
        outcome = IngestOutcome(path=source)
        ledger = Ledger.start_run(
            self._repository,
            trigger="ingest",
            pipeline_digest=self.pipeline_digest,
            batch_id=batch_id,
        )
        outcome.run_id = ledger.run_id
        try:
            self._run(source, ledger, outcome)
        except TombstonedError as exc:
            # Terminal by design. A tombstoned address is not retried, and the run is cancelled
            # rather than failed, because nothing went wrong: the user deleted something.
            outcome.error = f"tombstoned: {exc}"
            ledger.finish("cancelled")
            return outcome
        except Exception as exc:
            outcome.error = f"{type(exc).__name__}: {exc}"
            ledger.finish("failed")
            return outcome
        ledger.finish("succeeded")
        return outcome

    def _run(self, source: Path, ledger: Ledger, outcome: IngestOutcome) -> None:
        data = source.read_bytes()
        blob_id = BlobId.of_bytes(data)
        outcome.blob_id = blob_id
        # First, before the decode, before the object store, before a single row: is this
        # content allowed in at all? A tombstone discovered further down cancels the run and
        # rolls the rows back, but the store is not in that transaction, so bytes written
        # before the check would survive the cancellation and purged content would be back on
        # disk. Nothing below this line writes anything the check has not already permitted.
        self._repository.refuse_ingest_if_tombstoned(EvidenceAddress.photograph(blob_id))
        try:
            with Image.open(io.BytesIO(data)) as opened:
                opened.load()
                upright, facts = extract_exif_facts(opened)
        except (UnidentifiedImageError, OSError) as exc:
            raise ValueError(f"not a readable image: {exc}") from exc

        intake, capture_id, image_span_id = intake_stage.run(
            self, blob_id, data, upright.size, facts, ledger, outcome
        )
        ledger.attach_capture(capture_id)
        outcome.capture_id = capture_id

        rendition = rendition_stage.run(self, blob_id, upright, intake, ledger, outcome)
        vision_stage.run(
            self,
            self._vision,
            self._binding_for(STAGES["vision"]),
            blob_id,
            rendition,
            capture_id,
            image_span_id,
            facts,
            ledger,
            outcome,
        )
        # After vision, and from the UPRIGHT source rather than from the rendition. The rendition
        # is 768px and exists so a model can look at something small; depth is the geometry the
        # photograph will be walked through and is worth the full frame the size parameter allows.
        depth_stage.run(
            self,
            self._depth,
            self._binding_for(STAGES["depth"]),
            blob_id,
            upright,
            capture_id,
            image_span_id,
            intake,
            ledger,
            outcome,
        )


def _iter_images(directory: Path, *, recursive: bool) -> Iterator[Path]:
    """Every supported image under ``directory``, in a deterministic order."""
    if not directory.is_dir():
        raise NotADirectoryError(str(directory))
    paths: Iterable[Path] = directory.rglob("*") if recursive else directory.glob("*")
    for path in sorted(paths):
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES:
            yield path

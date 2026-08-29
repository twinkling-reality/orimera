"""The photograph ingest pipeline: a file on disk to persisted, provenance-tracked observations.

Four stages, each one idempotent by construction:

    intake     hash the bytes, read EXIF, normalise orientation, register the capture, the
               single-sample img track, the wall-clock anchor and the whole-image span, and
               emit the capture-supported assertions
    rendition  a 768 px display-space JPEG with no EXIF, the only pixels a model ever sees
    vision     one structured call, producing model inferences that each carry an evidence
               address and are filed as inference and never as anything else
    scene      time and GPS clustering across captures, producing PROPOSALS (see scenes.py)

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
import json
import uuid
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from PIL import Image, UnidentifiedImageError

from orimera.canonical import canonical_json, sha256_digest
from orimera.errors import TombstonedError
from orimera.evidence import PHOTOGRAPH_INTERVAL, EvidenceAddress
from orimera.evidence.blob import BlobId
from orimera.evidence.region import DisplayGeometry, Rect, Region
from orimera.identity.keys import occurrence_identity_key
from orimera.ingest.batch import IntakeBatch
from orimera.ingest.derivatives import render
from orimera.ingest.exif import ExifFacts, extract_exif_facts
from orimera.ingest.ledger import Ledger, StageRecorder
from orimera.ingest.repository import IngestRepository
from orimera.ingest.stages import (
    STAGES,
    StageSpec,
    artifact_id_for,
    idempotency_key,
    input_digest_of,
    pipeline_digest,
    stage,
)
from orimera.ingest.vision import (
    OBSERVATION_SCHEMA_NAME,
    PROMPT_VERSION,
    SCHEMA_VERSION,
    VisionModel,
    VisionObservation,
    prompt_digest,
)
from orimera.reconstruction import (
    DepthModel,
    DepthPrediction,
    RungDecision,
    Viewpoint,
    build_point_map,
    decide_rung,
    encode_opm,
)
from orimera.store.base import ContentAddressedStore

__all__ = ["SUPPORTED_SUFFIXES", "IngestOutcome", "IngestReport", "PhotoIngestPipeline"]

SUPPORTED_SUFFIXES: Final = frozenset({".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"})

#: Written onto every occurrence this pipeline creates, so a re-run at a new version is
#: distinguishable in the ledger from the same detector running twice.
_DETECTOR_VERSION: Final = "vision:1"


@dataclass(frozen=True, slots=True)
class StageResult:
    """A stage's output artifact, and whether it had to be produced."""

    artifact_id: uuid.UUID
    content_sha256: bytes
    idempotency_key: str
    reused: bool


@dataclass
class IngestOutcome:
    """What happened to one file."""

    path: Path
    blob_id: BlobId | None = None
    capture_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    stages_run: list[str] = field(default_factory=list)
    stages_reused: list[str] = field(default_factory=list)
    stages_skipped: list[str] = field(default_factory=list)
    model_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    error: str | None = None

    @property
    def unchanged(self) -> bool:
        """True when nothing new was computed: every stage resolved from an existing artifact."""
        return self.error is None and not self.stages_run

    @property
    def incomplete(self) -> bool:
        """True when a stage did not run at all, so this capture is not fully processed.

        Distinct from ``unchanged``. "Nothing was recomputed" and "something was never computed"
        are different states, and reporting them as one is how a corpus quietly ends up with no
        observations at all.
        """
        return self.error is None and bool(self.stages_skipped)


@dataclass
class IngestReport:
    """The summary a repeated directory run prints."""

    pipeline_digest: str
    outcomes: list[IngestOutcome] = field(default_factory=list)
    #: The watched intake this run belonged to, and what the formation stream is addressed by.
    #: None for an unwatched run, which is a real state rather than a missing value.
    batch_id: uuid.UUID | None = None

    @property
    def ingested(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.error is None and not o.unchanged]

    @property
    def unchanged(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.unchanged]

    @property
    def failed(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.error is not None]

    @property
    def incomplete(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.incomplete]

    @property
    def model_calls(self) -> int:
        return sum(o.model_calls for o in self.outcomes)


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

    def _binding_for(self, spec: StageSpec) -> dict[str, str] | None:
        return self._bindings.get(spec.key)

    @contextmanager
    def _committed_writes(self) -> Iterator[list[bytes]]:
        """A database transaction whose object-store writes happen **after** it commits.

        The store is not transactional and cannot be enrolled in one, so a payload written
        inside a transaction survives that transaction's rollback. Two consequences, one of
        them serious:

        *   A tombstoned import is cancelled and its rows roll back, and the purged bytes are
            back on disk. Deletion that a retry undoes is not deletion.
        *   An ordinary stage failure leaves an orphan object nothing references.

        Deferring the write past the commit inverts the failure mode into the recoverable one:
        a crash in the window between commit and flush leaves a row whose bytes are missing,
        which ``_persist_artifact`` and ``_rendition`` already detect and heal by recomputing.
        No compensating cleanup is needed, because nothing was written that would need cleaning
        up; ordering genuinely is sufficient here, which is why it is done by ordering.
        """
        pending: list[bytes] = []
        with self._repository.transaction():
            yield pending
        for payload in pending:
            self._store.put_bytes(payload)

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

        intake, capture_id, image_span_id = self._intake(
            blob_id, data, upright.size, facts, ledger, outcome
        )
        ledger.attach_capture(capture_id)
        outcome.capture_id = capture_id

        rendition = self._rendition(blob_id, upright, intake, ledger, outcome)
        self._vision_stage(
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
        self._depth_stage(
            blob_id, upright, capture_id, image_span_id, intake, ledger, outcome
        )

    # -- stage 1: intake ----------------------------------------------------------------

    def _intake(
        self,
        blob_id: BlobId,
        data: bytes,
        display_size: tuple[int, int],
        facts: ExifFacts,
        ledger: Ledger,
        outcome: IngestOutcome,
    ) -> tuple[StageResult, uuid.UUID, uuid.UUID]:
        spec = stage("intake")
        input_digest = input_digest_of([])
        key = idempotency_key(blob_id, spec, input_digest)
        probe_bytes = canonical_json(facts.as_probe_json())

        with ledger.stage(spec, input_blob=blob_id) as recorder:
            with self._committed_writes() as pending:
                # Queued, not written. The source bytes land in the store only once the whole
                # intake transaction has committed, so a tombstone that fires on ``upsert_span``
                # below leaves the store exactly as it found it.
                pending.append(data)
                self._repository.upsert_blob(
                    blob_id,
                    byte_size=len(data),
                    media_type=facts.media_type,
                    storage_key=self._store.key_for(blob_id),
                )
                capture = self._repository.live_capture_for_blob(blob_id)
                if capture is None:
                    capture = self._repository.insert_capture(
                        blob_id,
                        device_id=facts.device_id,
                        started_at=facts.clock.utc.isoformat() if facts.clock else None,
                    )
                track_id = self._repository.upsert_image_track(
                    blob_id,
                    coded_w=facts.coded_width,
                    coded_h=facts.coded_height,
                    disp_w=display_size[0],
                    disp_h=display_size[1],
                    rotation=facts.orientation.rotation_degrees,
                    codec=facts.codec,
                    probe_json=facts.as_probe_json(),
                )
                if facts.clock is not None:
                    self._repository.insert_clock_anchor(
                        track_id,
                        utc_instant=facts.clock.utc.isoformat(),
                        source=facts.clock.source,
                        uncertainty_ms=facts.clock.uncertainty_ms,
                    )
                image_address = EvidenceAddress.photograph(blob_id)
                image_span_id = self._repository.upsert_span(image_address)
                result = self._persist_artifact(
                    spec=spec,
                    blob_id=blob_id,
                    key=key,
                    input_digest=input_digest,
                    payload=probe_bytes,
                    recorder=recorder,
                    outcome=outcome,
                    pending=pending,
                    produced_by_event=recorder.stage_started_event,
                )
                emitted = self._capture_assertions(
                    facts, capture.capture_id, image_span_id, key, ledger
                )
            ledger.emitted("assertion", emitted, spec)
        return result, capture.capture_id, image_span_id

    def _capture_assertions(
        self,
        facts: ExifFacts,
        capture_id: uuid.UUID,
        image_span_id: uuid.UUID,
        key: str,
        ledger: Ledger,
    ) -> list[uuid.UUID]:
        """The whole of the ``capture`` class for a photograph, and nothing more.

        File hash, byte size, pixel dimensions, EXIF device model, EXIF timestamps, EXIF GPS.
        Everything else a photograph "says" is inference, and none of it is written here.
        """
        subject = {"type": "capture", "id": str(capture_id)}
        support = [image_span_id]
        claims: list[tuple[str, Any]] = [
            ("pixel_size_is", {"w": facts.display_width, "h": facts.display_height}),
        ]
        if facts.clock is not None:
            claims.append(("captured_at", facts.clock.utc.isoformat()))
        if facts.device_id is not None:
            claims.append(("device_model_is", facts.device_id))
        if facts.gps is not None:
            claims.append(("gps_position_is", facts.gps.as_object_value()))
        emitted: list[uuid.UUID] = []
        for ordinal, (predicate_key, value) in enumerate(claims):
            assertion_id = self._repository.insert_assertion(
                kind="capture",
                predicate_key=predicate_key,
                subject_ref=subject,
                object_value=value,
                emit_key=f"{key}:a:{ordinal}",
                support_span_ids=support,
                produced_by_run=ledger.run_id,
            )
            if assertion_id is not None:
                emitted.append(assertion_id)
        return emitted

    # -- stage 2: rendition -------------------------------------------------------------

    def _rendition(
        self,
        blob_id: BlobId,
        upright: Image.Image,
        intake: StageResult,
        ledger: Ledger,
        outcome: IngestOutcome,
    ) -> StageResult:
        spec = stage("rendition")
        input_digest = input_digest_of([intake.content_sha256])
        key = idempotency_key(blob_id, spec, input_digest)
        existing = self._repository.find_artifact(key)
        if (
            existing is not None
            and existing.content_sha256 is not None
            and self._store.exists(BlobId(existing.content_sha256))
        ):
            # The whole file is already encoded and stored. No decode, no resample, no write.
            # Recorded, because a stage satisfied without running is still a step in the DAG and
            # the replay is generated from the ledger and from nothing else.
            outcome.stages_reused.append(spec.key)
            ledger.reused(spec, existing.artifact_id, input_blob=blob_id)
            return StageResult(
                artifact_id=existing.artifact_id,
                content_sha256=existing.content_sha256,
                idempotency_key=key,
                reused=True,
            )
        with ledger.stage(
            spec, input_artifact_ids=[intake.artifact_id], input_blob=blob_id
        ) as recorder:
            encoded = render(upright, spec)
            with self._committed_writes() as pending:
                result = self._persist_artifact(
                    spec=spec,
                    blob_id=blob_id,
                    key=key,
                    input_digest=input_digest,
                    payload=encoded.data,
                    recorder=recorder,
                    outcome=outcome,
                    pending=pending,
                    produced_by_event=recorder.stage_started_event,
                )
        return result

    # -- stage 3: vision ----------------------------------------------------------------

    def _vision_stage(
        self,
        blob_id: BlobId,
        rendition: StageResult,
        capture_id: uuid.UUID,
        image_span_id: uuid.UUID,
        facts: ExifFacts,
        ledger: Ledger,
        outcome: IngestOutcome,
    ) -> None:
        spec = stage("vision")
        if self._vision is None:
            # Checked before the key rather than after it. The key names the model that will
            # produce the output, and with no model configured there is no such name, so there
            # is no key to look an artifact up by. Reporting this as skipped rather than reused
            # is also the more honest of the two: this run did not process vision.
            outcome.stages_skipped.append(spec.key)
            return
        input_digest = input_digest_of([rendition.content_sha256])
        key = idempotency_key(
            blob_id, spec, input_digest, binding=self._binding_for(spec)
        )
        existing = self._repository.find_artifact(key)
        if existing is not None:
            # The whole cost control, in one branch: the second run of a directory reaches this
            # line for every photograph and issues no model call at all. It is also where an
            # edited prompt or a swapped model correctly misses, because both are inside the
            # key: the prompt through ``params["prompt_sha256"]`` and the model through the
            # binding.
            outcome.stages_reused.append(spec.key)
            ledger.reused(spec, existing.artifact_id, input_blob=blob_id)
            return

        image_bytes = self._store.get(BlobId(rendition.content_sha256))
        with ledger.stage(
            spec, input_artifact_ids=[rendition.artifact_id], input_blob=blob_id
        ) as recorder:
            result = self._vision.observe(image_bytes=image_bytes, media_type="image/jpeg")
            recorder.record_model_call(result.model_ref, result.cost, result.attempts)
            outcome.model_calls += 1
            outcome.input_tokens += int(result.cost.get("input_tokens", 0))
            outcome.output_tokens += int(result.cost.get("output_tokens", 0))

            document = {
                "header": {
                    "stage_key": spec.key,
                    "stage_version": spec.version,
                    "schema_version": SCHEMA_VERSION,
                    "schema_name": OBSERVATION_SCHEMA_NAME,
                    "prompt_version": PROMPT_VERSION,
                    "prompt_sha256": prompt_digest(),
                    "params_digest": spec.params_digest.hex(),
                    "model_ref": result.model_ref,
                    "models_tried": list(result.tried),
                    "usage": result.cost,
                    # Everything below is derived from pixels the system did not author, so it
                    # is untrusted for every downstream purpose, and anything derived from it
                    # inherits the tier. A summary of an injected sign does not become
                    # trustworthy by passing through a model once.
                    "trust_tier": "T2",
                    "epistemic_class": "inference",
                },
                "observation": result.payload,
                # Recorded so the artifact says what the detector called the people it saw.
                # None of these strings is a name and none of them can become one: `occurrence`
                # has no column for a name, and `entity.display_name` is refused by trigger
                # unless an active kind='user' assertion says so.
                "person_labels": result.observation.person_labels,
            }
            with self._committed_writes() as pending:
                self._persist_artifact(
                    spec=spec,
                    blob_id=blob_id,
                    key=key,
                    input_digest=input_digest,
                    payload=_verbatim_json(document),
                    recorder=recorder,
                    outcome=outcome,
                    pending=pending,
                    produced_by_event=recorder.stage_started_event,
                )
                emitted = self._observation_rows(
                    result.observation,
                    blob_id=blob_id,
                    capture_id=capture_id,
                    image_span_id=image_span_id,
                    display=DisplayGeometry(
                        w=facts.display_width, h=facts.display_height, rotation=0
                    ),
                    key=key,
                    ledger=ledger,
                )
            ledger.emitted("assertion", emitted, spec)

    def _observation_rows(
        self,
        observation: VisionObservation,
        *,
        blob_id: BlobId,
        capture_id: uuid.UUID,
        image_span_id: uuid.UUID,
        display: DisplayGeometry,
        key: str,
        ledger: Ledger,
    ) -> list[uuid.UUID]:
        """Turn a validated observation into spans, occurrences and inference assertions.

        Every row written here is ``kind='inference'`` and carries at least one evidence
        address. There is no branch that can write one as ``capture``: the predicate vocabulary
        refuses it at the data layer.
        """
        repository = self._repository
        emitted: list[uuid.UUID] = []
        ordinal = 0

        def emit(**kwargs: Any) -> None:
            nonlocal ordinal
            assertion_id = repository.insert_assertion(
                kind="inference",
                produced_by_run=ledger.run_id,
                emit_key=f"{key}:a:{ordinal}",
                **kwargs,
            )
            ordinal += 1
            if assertion_id is not None:
                emitted.append(assertion_id)

        emit(
            predicate_key="caption_is",
            subject_ref={"type": "capture", "id": str(capture_id)},
            object_value=observation.scene_description,
            support_span_ids=[image_span_id],
        )

        # People first, so their emit-key ordinals are stable as the object list changes.
        for index, person in enumerate(observation.person_objects):
            span_id, address = self._region_span(blob_id, person.box, display, image_span_id)
            emit(
                predicate_key="person_present",
                subject_ref={"type": "capture", "id": str(capture_id)},
                support_span_ids=[span_id],
            )
            if address is None:
                # A person with no usable box has no distinguishing evidence address, so every
                # unlocated person in this photograph would share one identity key. Rejection
                # memory is keyed on that, so they would suppress each other's proposals. The
                # claim that somebody is present still stands: it is the assertion above.
                continue
            repository.insert_occurrence(
                capture_id=capture_id,
                occurrence_class="person",
                primary_span_id=span_id,
                span_ids=[span_id],
                presence=[(PHOTOGRAPH_INTERVAL.start_ns, PHOTOGRAPH_INTERVAL.end_ns)],
                produced_by_run=ledger.run_id,
                detector_version=_DETECTOR_VERSION,
                identity_key=occurrence_identity_key(address, "person"),
                emit_key=f"{key}:p:{index}",
                quality={
                    "confidence_band": person.confidence,
                    "salience": person.salience,
                    # The detector's own word for what it saw, kept because it is evidence
                    # about the detection. It is NOT a name and there is no column for one:
                    # `occurrence` has no display_name, and `entity.display_name` is enforced
                    # by trigger to require an active user assertion.
                    "label": person.label,
                    "trust_tier": "T2",
                },
            )

        for index, detected in enumerate(observation.non_person_objects):
            span_id, address = self._region_span(blob_id, detected.box, display, image_span_id)
            emit(
                predicate_key="object_present",
                subject_ref={"type": "capture", "id": str(capture_id)},
                object_value=detected.label,
                support_span_ids=[span_id],
            )
            if address is not None:
                # An occurrence is created only for a located object. Without a region every
                # boxless object in one photograph would share an identity key, which is what
                # rejection memory is keyed on, so they would suppress each other's proposals.
                repository.insert_occurrence(
                    capture_id=capture_id,
                    occurrence_class="object",
                    primary_span_id=span_id,
                    span_ids=[span_id],
                    presence=[(PHOTOGRAPH_INTERVAL.start_ns, PHOTOGRAPH_INTERVAL.end_ns)],
                    produced_by_run=ledger.run_id,
                    detector_version=_DETECTOR_VERSION,
                    identity_key=occurrence_identity_key(address, "object"),
                    emit_key=f"{key}:o:{index}",
                    quality={
                        "confidence_band": detected.confidence,
                        "salience": detected.salience,
                        "label": detected.label,
                        "trust_tier": "T2",
                    },
                )

        for legible in observation.legible_text:
            span_id, _ = self._region_span(blob_id, legible.box, display, image_span_id)
            emit(
                predicate_key="ocr_text_is",
                subject_ref={"type": "capture", "id": str(capture_id)},
                object_value=legible.text,
                support_span_ids=[span_id],
            )

        place = observation.proposed_place
        if place is not None:
            emit(
                predicate_key="place_is",
                subject_ref={"type": "capture", "id": str(capture_id)},
                object_value=place.label,
                support_span_ids=[image_span_id],
            )
            repository.insert_occurrence(
                capture_id=capture_id,
                occurrence_class="place",
                primary_span_id=image_span_id,
                span_ids=[image_span_id],
                presence=[(PHOTOGRAPH_INTERVAL.start_ns, PHOTOGRAPH_INTERVAL.end_ns)],
                produced_by_run=ledger.run_id,
                detector_version=_DETECTOR_VERSION,
                identity_key=occurrence_identity_key(EvidenceAddress.photograph(blob_id), "place"),
                emit_key=f"{key}:o:place",
                quality={
                    "confidence_band": place.confidence,
                    "basis": place.basis,
                    "trust_tier": "T2",
                },
            )
        return emitted

    def _region_span(
        self,
        blob_id: BlobId,
        box: Any,
        display: DisplayGeometry,
        image_span_id: uuid.UUID,
    ) -> tuple[uuid.UUID, EvidenceAddress | None]:
        """A span for a located item, or the whole-image span when there is no usable box."""
        if box is None:
            return image_span_id, None
        clamped, _ = box.clamped()
        if clamped.is_degenerate:
            return image_span_id, None
        address = EvidenceAddress.photograph(
            blob_id,
            region=Region(
                rect=Rect.from_normalised(clamped.x, clamped.y, clamped.w, clamped.h),
                display=display,
            ),
        )
        return self._repository.upsert_span(address), address

    # -- shared artifact write ----------------------------------------------------------

    def _persist_artifact(
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
        surrounding transaction has committed. See ``_committed_writes``.

        The two hashes are kept apart on purpose. ``idempotency_key`` is what the output should
        be, computed before running. ``content_sha256`` is what it turned out to be. When a
        deterministic stage produces different content under the same key, that is worth an
        event rather than a silent overwrite, and the existing artifact is kept: mutating it
        would break every citation and every replay that already points at it.
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


    # -- stage 4: depth ------------------------------------------------------------------

    def _depth_stage(
        self,
        blob_id: BlobId,
        upright: Image.Image,
        capture_id: uuid.UUID,
        image_span_id: uuid.UUID,
        intake: StageResult,
        ledger: Ledger,
        outcome: IngestOutcome,
    ) -> None:
        """One photograph becomes a metric point map, and the rung it earned is recorded.

        **The point map is an artifact and never a blob.** Invariant 2: reconstruction is never
        evidence. An ``evidence_span`` references ``blob``, artifacts do not live there, and so a
        point map has nothing a citation could point at. That is structural rather than guarded,
        and ``tests/test_reconstruction_is_not_evidence.py`` asserts it from four directions.

        **The rung is a proposal about presentation, not a claim about the world.** It is written
        as an inference-class assertion on the capture, which is the only class it could honestly
        take: a model looked at a photograph and reported how much of it could be placed. It
        supports no historical clause and could not, because the vocabulary refuses.

        With no depth model configured the stage is reported as SKIPPED rather than run, exactly
        as vision is. A capture with no point map is a rung 4 region, which is a real rung with a
        real experience, and the absence of a stage is not the same fact as a stage that failed.
        """
        spec = stage("depth")
        if self._depth is None:
            outcome.stages_skipped.append(spec.key)
            return

        input_digest = input_digest_of([intake.content_sha256])
        key = idempotency_key(blob_id, spec, input_digest, binding=self._binding_for(spec))
        existing = self._repository.find_artifact(key)
        if existing is not None:
            outcome.stages_reused.append(spec.key)
            ledger.reused(spec, existing.artifact_id, input_blob=blob_id)
            return

        with ledger.stage(
            spec, input_artifact_ids=[intake.artifact_id], input_blob=blob_id
        ) as recorder:
            prediction = self._depth.predict(upright)
            points = build_point_map(prediction, upright)
            decision = decide_rung(
                prediction,
                min_valid_fraction=int(spec.params["min_valid_fraction_milli"]) / 1000,
            )
            payload = encode_opm(
                points,
                generator=prediction.model_id,
                viewpoint=Viewpoint(
                    fov_y_degrees=prediction.fov_y_degrees,
                    aspect=prediction.width / max(1, prediction.height),
                ),
                source_size=upright.size,
                # Carried from the model rather than assumed. A map that is not metric produces a
                # region that is not metric, and a spatial question over it refuses with a stated
                # reason instead of estimating a distance.
                metric=prediction.metric,
            )
            with self._committed_writes() as pending:
                result = self._persist_artifact(
                    spec=spec,
                    blob_id=blob_id,
                    key=key,
                    input_digest=input_digest,
                    payload=payload,
                    recorder=recorder,
                    outcome=outcome,
                    pending=pending,
                )
                self._record_rung(
                    capture_id, image_span_id, decision, result, prediction, ledger
                )
        # `_persist_artifact` already recorded the stage as run. Appending it here as well is what
        # printed "depth+depth" in the command line's per-file summary.

    def _record_rung(
        self,
        capture_id: uuid.UUID,
        image_span_id: uuid.UUID,
        decision: RungDecision,
        result: StageResult,
        prediction: DepthPrediction,
        ledger: Ledger,
    ) -> None:
        """Write the rung as what it is: something a model inferred about a photograph.

        ``inference`` and not ``capture``. A capture-supported fact is a deterministic property of
        the bytes, and how much of a frame a neural network could place is not one: a different
        checkpoint would give a different answer over the same file. Filing it as capture would be
        the exact flattening invariant 4 forbids.

        **It cites the photograph, not the point map**, and the support-span rule is what forced
        the question. An inference must name at least one evidence span, so a rung had to point at
        something; the only honest answer is the frame the model looked at. Citing the point map
        would have required the point map to be evidence, which is the thing invariant 2 exists to
        prevent, and the constraint refused it before anybody had to notice.
        """
        assertion_id = self._repository.insert_assertion(
            kind="inference",
            predicate_key="reconstruction_rung_is",
            subject_ref={"type": "capture", "id": str(capture_id)},
            object_value={
                **decision.as_payload(),
                "model_id": prediction.model_id,
                "metric": prediction.metric,
                # The artifact id, so an interface explaining a rung can open the map it is
                # about. An artifact id and an evidence address are not the same kind of thing
                # and this is not a citation: nothing resolves it through the evidence route.
                "point_map_artifact": str(result.artifact_id),
            },
            emit_key=f"{result.idempotency_key}:rung",
            support_span_ids=[image_span_id],
            produced_by_run=ledger.run_id,
        )
        if assertion_id is not None:
            ledger.emitted("assertion", [assertion_id], stage("depth"))


def _verbatim_json(document: dict[str, Any]) -> bytes:
    """Serialise a vision artifact exactly as the model wrote it.

    Deliberately not ``orimera.canonical.canonical_json``, which refuses floats. That refusal
    is right for a digest input, where two implementations must agree byte for byte, and wrong
    here: this artifact is the record of what the model actually said, and rewriting its
    numbers into another representation before storing it would make the audit record something
    other than the model's output. Nothing downstream hashes this document as a digest input;
    ``content_sha256`` is a hash of the stored bytes, which is a different claim.

    The coordinates that DO enter a digest are quantised to integers first, in
    ``orimera.evidence.region``, before any span is built from them.
    """
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def _iter_images(directory: Path, *, recursive: bool) -> Iterator[Path]:
    """Every supported image under ``directory``, in a deterministic order."""
    if not directory.is_dir():
        raise NotADirectoryError(str(directory))
    paths: Iterable[Path] = directory.rglob("*") if recursive else directory.glob("*")
    for path in sorted(paths):
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES:
            yield path

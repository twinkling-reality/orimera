"""The photograph ingest pipeline.

From a file on disk to persisted, provenance-tracked observations, with four properties that
are structural rather than promised:

*   Orientation is normalised once, at intake, and recorded. Regions are in upright display
    space forever, so a mirrored original cannot place a citation on the wrong side of a photo.
*   Every derivative is keyed by ``(source hash, stage, stage version, params, input digest,
    run-time binding)``, so a second run makes zero model calls and re-bills nothing, while an
    edited prompt or a swapped model does reprocess.
*   Every model output is filed as ``inference`` and carries an evidence address. The predicate
    vocabulary refuses a caption filed as capture-supported and refuses a name from a model at
    all.
*   Nothing here can create an entity or a link. Grouping and place candidates are proposals in
    ``derived_artifact``, awaiting a human.
"""

from __future__ import annotations

from orimera.errors import EpistemicViolation, TombstonedError
from orimera.identity.keys import occurrence_identity_key
from orimera.ingest.exif import ExifFacts, extract_exif_facts, normalise_orientation
from orimera.ingest.ledger import Ledger
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.ingest.report import IngestOutcome, IngestReport
from orimera.ingest.repository import IngestRepository
from orimera.ingest.resolve import resolve_region_image
from orimera.ingest.scenes import SceneGroup, group_captures, run_scene_grouping
from orimera.ingest.stages import STAGES, StageSpec, pipeline_digest
from orimera.ingest.vision import (
    OBSERVATION_SCHEMA,
    NebiusVisionModel,
    VisionModel,
    VisionObservation,
    VisionResult,
    validate_observation,
)
from orimera.store.resolve import address_from_span_row, resolve_original_bytes

__all__ = [
    "OBSERVATION_SCHEMA",
    "STAGES",
    "EpistemicViolation",
    "ExifFacts",
    "IngestOutcome",
    "IngestReport",
    "IngestRepository",
    "Ledger",
    "NebiusVisionModel",
    "PhotoIngestPipeline",
    "SceneGroup",
    "StageSpec",
    "TombstonedError",
    "VisionModel",
    "VisionObservation",
    "VisionResult",
    "address_from_span_row",
    "extract_exif_facts",
    "group_captures",
    "normalise_orientation",
    "occurrence_identity_key",
    "pipeline_digest",
    "resolve_original_bytes",
    "resolve_region_image",
    "run_scene_grouping",
    "validate_observation",
]

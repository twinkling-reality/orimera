"""Reconstruction: one photograph becomes a metric point map, and never becomes evidence.

**Invariant 2 is structural here.** This package does not import ``orimera.evidence``,
``orimera.store`` or ``orimera.db``, an import-linter contract enforces it, and
``tests/test_reconstruction_is_not_evidence.py`` fails if any module in here so much as names an
evidence address in a return annotation. A producer that cannot construct a citation cannot
return one, however it is later changed by somebody who never read this sentence.

That absence is the whole product's safety margin. Reconstruction quality never participates in
the truth guarantee: a region may degrade to a photograph on a plane and the factual promise is
unchanged, which is only true while a claim cannot resolve to geometry. The point map is stored,
rendered and displayed with the rung it earned; it is never what a citation opens.

**What is here.** A depth model behind a protocol, with MoGe-2 as the real implementation and a
flat plane as the double; the point-map builder that drops what the model could not place; the
``.opm`` writer the renderer already reads; the quality gate that decides between rung 3 and rung
4 for one photograph; and the job controllers for the rungs above it, ``pose`` for camera
recovery, ``splat`` for training and ``navigation`` for corridors.

**What "above rung 3" means here, precisely, because the distinction keeps being lost.** The
controllers exist and are contract tested. ``pose`` now also has a backend that runs, the
in-process ``pycolmap_executor``, so camera recovery is executable on an ordinary machine.
``splat`` does not: it delegates to a reviewed container entrypoint that nobody has built, and
gsplat is CUDA only, so no splat has ever been trained here. Nothing in ``orimera.ingest`` calls
any of the three, so no rung above 3 is published to the Atlas by any pipeline today. ``gate.py``
decides rung 3 or rung 4 for a single photograph and is not the gate for the rungs above it;
those are the quality receipts the controllers return.
"""

from __future__ import annotations

from orimera.reconstruction.build import (
    DEFAULT_MAX_DEPTH_STEP,
    DEFAULT_SEGMENT,
    build_point_map,
)
from orimera.reconstruction.depth import DepthModel, DepthPrediction
from orimera.reconstruction.gate import MIN_VALID_FRACTION, RungDecision, decide_rung
from orimera.reconstruction.navigation import (
    CorridorArtifact,
    CorridorBuildManifest,
    Destination,
    NavigationPoseSample,
    build_corridor_artifact,
    validate_corridor_artifact,
)
from orimera.reconstruction.opm import (
    OPM_MAGIC,
    OPM_SECTIONS,
    OPM_VERSION,
    SUPERSEDED_OPM_VERSION,
    ColorAlpha,
    Viewpoint,
    encode_opm,
)
from orimera.reconstruction.placement import (
    PLACEMENT_PROFILE,
    ExcludedPlacementMember,
    PlacedPointMap,
    PlacementRecord,
    PointMapInput,
    build_placement_record,
    validate_placement_record,
)
from orimera.reconstruction.pointmap import (
    MAX_SEGMENT_ID,
    POINT_STRIDE_BYTES,
    RESERVED_TAG_FLAGS,
    TAG_ONE_SIDED,
    PointMap,
    Segment,
)
from orimera.reconstruction.pose import (
    CommandResult,
    PoseBuildManifest,
    PoseJobResult,
    PoseQuality,
    RecoveredCamera,
    SourceFrame,
    run_colmap_pose_job,
)
from orimera.reconstruction.scene_gate import (
    SCENE_GATE_PROFILE,
    ReceiptMeasurement,
    SceneGateDecision,
    SceneGateInputs,
    SceneReceipt,
    decide_scene_rung,
)
from orimera.reconstruction.splat import (
    SplatBuildManifest,
    SplatJobResult,
    SplatQuality,
    run_gsplat_job,
)
from orimera.reconstruction.validation import (
    OpmIntegrityError,
    OpmIntegrityReport,
    validate_opm,
)

__all__ = [
    "DEFAULT_MAX_DEPTH_STEP",
    "DEFAULT_SEGMENT",
    "MAX_SEGMENT_ID",
    "MIN_VALID_FRACTION",
    "OPM_MAGIC",
    "OPM_SECTIONS",
    "OPM_VERSION",
    "PLACEMENT_PROFILE",
    "POINT_STRIDE_BYTES",
    "RESERVED_TAG_FLAGS",
    "SCENE_GATE_PROFILE",
    "SUPERSEDED_OPM_VERSION",
    "TAG_ONE_SIDED",
    "ColorAlpha",
    "CommandResult",
    "CorridorArtifact",
    "CorridorBuildManifest",
    "DepthModel",
    "DepthPrediction",
    "Destination",
    "ExcludedPlacementMember",
    "NavigationPoseSample",
    "OpmIntegrityError",
    "OpmIntegrityReport",
    "PlacedPointMap",
    "PlacementRecord",
    "PointMap",
    "PointMapInput",
    "PoseBuildManifest",
    "PoseJobResult",
    "PoseQuality",
    "ReceiptMeasurement",
    "RecoveredCamera",
    "RungDecision",
    "SceneGateDecision",
    "SceneGateInputs",
    "SceneReceipt",
    "Segment",
    "SourceFrame",
    "SplatBuildManifest",
    "SplatJobResult",
    "SplatQuality",
    "Viewpoint",
    "build_corridor_artifact",
    "build_placement_record",
    "build_point_map",
    "decide_rung",
    "decide_scene_rung",
    "encode_opm",
    "run_colmap_pose_job",
    "run_gsplat_job",
    "validate_corridor_artifact",
    "validate_opm",
    "validate_placement_record",
]

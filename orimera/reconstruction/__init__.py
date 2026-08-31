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
``.opm`` writer the renderer already reads; and the quality gate that decides between rung 3 and
rung 4 and can decide nothing else, because the producers of rungs 1 and 2 do not exist.
"""

from __future__ import annotations

from orimera.reconstruction.build import DEFAULT_SEGMENT, build_point_map
from orimera.reconstruction.depth import DepthModel, DepthPrediction
from orimera.reconstruction.gate import MIN_VALID_FRACTION, RungDecision, decide_rung
from orimera.reconstruction.opm import OPM_MAGIC, OPM_VERSION, Viewpoint, encode_opm
from orimera.reconstruction.pointmap import POINT_STRIDE_BYTES, PointMap, Segment
from orimera.reconstruction.validation import (
    OpmIntegrityError,
    OpmIntegrityReport,
    validate_opm,
)

__all__ = [
    "DEFAULT_SEGMENT",
    "MIN_VALID_FRACTION",
    "OPM_MAGIC",
    "OPM_VERSION",
    "POINT_STRIDE_BYTES",
    "DepthModel",
    "DepthPrediction",
    "OpmIntegrityError",
    "OpmIntegrityReport",
    "PointMap",
    "RungDecision",
    "Segment",
    "Viewpoint",
    "build_point_map",
    "decide_rung",
    "encode_opm",
    "validate_opm",
]

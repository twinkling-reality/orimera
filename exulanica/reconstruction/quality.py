"""Measured rung-3 publication observations and an honest corpus gate.

This module deliberately does not run a model or discover files.  It aggregates observations a
caller actually measured: OPM validation, PlayCanvas consumption, source opening, visual camera
alignment, deletion closure, time, cost, and bytes.  Missing measurements stay ``None`` and keep
the gate blocked.  Synthetic observations are useful for contract tests but can never pass the
real-corpus gate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median
from typing import Literal

__all__ = [
    "CorpusKind",
    "PointMapQualityObservation",
    "PointMapQualityReport",
    "build_quality_report",
]

CorpusKind = Literal["real-consented", "synthetic", "development"]
Check = Literal["passed", "failed", "not-run"]


@dataclass(frozen=True, slots=True)
class PointMapQualityObservation:
    """Facts measured for one source, not estimates filled to make a row complete."""

    capture_ref: str
    artifact_sha256: str | None
    rung: Literal[3, 4]
    valid_fraction: float
    metric: bool | None
    opm_integrity: Check
    playcanvas_consumption: Check
    source_opened: Check
    source_camera_visual_alignment: Check
    deletion_closure: Check
    byte_length: int | None = None
    production_duration_ms: float | None = None
    browser_load_duration_ms: float | None = None
    usd_cost: float | None = None

    def __post_init__(self) -> None:
        if not self.capture_ref:
            raise ValueError("capture_ref is required")
        if not 0 <= self.valid_fraction <= 1 or not math.isfinite(self.valid_fraction):
            raise ValueError("valid_fraction must be finite and between zero and one")
        if self.artifact_sha256 is not None and (
            len(self.artifact_sha256) != 64
            or any(c not in "0123456789abcdef" for c in self.artifact_sha256)
        ):
            raise ValueError("artifact_sha256 must be lowercase SHA-256 hex or absent")
        for name in (
            "byte_length",
            "production_duration_ms",
            "browser_load_duration_ms",
            "usd_cost",
        ):
            value = getattr(self, name)
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError(f"{name} must be a non-negative measured value or absent")


@dataclass(frozen=True, slots=True)
class PointMapQualityReport:
    corpus_kind: CorpusKind
    observations: tuple[PointMapQualityObservation, ...]
    distributions: dict[str, dict[str, float]]
    blockers: tuple[str, ...]

    @property
    def gate_passed(self) -> bool:
        return not self.blockers

    def as_payload(self) -> dict[str, object]:
        return {
            "profile": "exulanica.point-map-quality/v1",
            "corpus_kind": self.corpus_kind,
            "observation_count": len(self.observations),
            "distributions": self.distributions,
            "gate": {"passed": self.gate_passed, "blockers": list(self.blockers)},
            "observations": [
                {
                    "capture_ref": item.capture_ref,
                    "artifact_sha256": item.artifact_sha256,
                    "rung": item.rung,
                    "valid_fraction": item.valid_fraction,
                    "metric": item.metric,
                    "opm_integrity": item.opm_integrity,
                    "playcanvas_consumption": item.playcanvas_consumption,
                    "source_opened": item.source_opened,
                    "source_camera_visual_alignment": item.source_camera_visual_alignment,
                    "deletion_closure": item.deletion_closure,
                    "byte_length": item.byte_length,
                    "production_duration_ms": item.production_duration_ms,
                    "browser_load_duration_ms": item.browser_load_duration_ms,
                    "usd_cost": item.usd_cost,
                }
                for item in self.observations
            ],
        }


def _distribution(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)

    def percentile(fraction: float) -> float:
        if len(ordered) == 1:
            return ordered[0]
        position = fraction * (len(ordered) - 1)
        low = math.floor(position)
        high = math.ceil(position)
        weight = position - low
        return ordered[low] * (1 - weight) + ordered[high] * weight

    return {
        "min": ordered[0],
        "p50": median(ordered),
        "p95": percentile(0.95),
        "max": ordered[-1],
    }


def build_quality_report(
    corpus_kind: CorpusKind, observations: list[PointMapQualityObservation]
) -> PointMapQualityReport:
    """Aggregate only present measurements and name every reason publication is blocked."""
    fields = (
        "valid_fraction",
        "byte_length",
        "production_duration_ms",
        "browser_load_duration_ms",
        "usd_cost",
    )
    distributions: dict[str, dict[str, float]] = {}
    for field in fields:
        measured = [
            float(value)
            for item in observations
            if (value := getattr(item, field)) is not None
        ]
        if measured:
            distributions[field] = _distribution(measured)

    blockers: list[str] = []
    if corpus_kind != "real-consented":
        blockers.append("quality distributions were not measured on the consented real corpus")
    if not observations:
        blockers.append("no point-map observations were supplied")
    required = (
        "opm_integrity",
        "playcanvas_consumption",
        "source_opened",
        "source_camera_visual_alignment",
        "deletion_closure",
    )
    for item in observations:
        for field in required:
            state = getattr(item, field)
            if state != "passed":
                blockers.append(f"{item.capture_ref}: {field} is {state}")
        if item.rung == 3 and item.artifact_sha256 is None:
            blockers.append(f"{item.capture_ref}: rung 3 has no point-map artifact digest")
        if item.rung == 4 and item.source_opened != "passed":
            blockers.append(f"{item.capture_ref}: rung 4 has no authorized source-first result")

    return PointMapQualityReport(
        corpus_kind=corpus_kind,
        observations=tuple(observations),
        distributions=distributions,
        blockers=tuple(sorted(set(blockers))),
    )

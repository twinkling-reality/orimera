"""The scene-level rung gate that composes durable receipts.

The single-frame gate in ``gate.py`` remains limited to rungs 3 and 4. This gate reads facts
about a set. It does not copy numerical thresholds out of producer manifests: pose, scale,
coverage, corridor and splat receipts own the convention and threshold that gave their
``accepted`` result. The decision records every receipt digest it read and every reason it did
not advance, so a later producer is additive rather than a reinterpretation of an old claim.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Final, Literal

__all__ = [
    "SCENE_GATE_PROFILE",
    "ReceiptMeasurement",
    "SceneGateDecision",
    "SceneGateInputs",
    "SceneReceipt",
    "decide_scene_rung",
    "validate_scene_gate_decision",
]

SCENE_GATE_PROFILE: Final = "orimera.reconstruction-scene-gate/v1"


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require_digest(value: str, field: str) -> None:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError(f"{field} must be lowercase SHA-256 hex")


@dataclass(frozen=True, slots=True)
class ReceiptMeasurement:
    """One numerical observation and the convention that gives it meaning."""

    name: str
    value: float
    unit: str
    convention: str

    def __post_init__(self) -> None:
        if not self.name or not self.unit or not self.convention:
            raise ValueError("a measurement needs a name, unit and convention")
        if not math.isfinite(self.value):
            raise ValueError("a measurement value must be finite")

    def as_payload(self) -> dict[str, object]:
        return {
            "name": self.name,
            "value": self.value,
            "unit": self.unit,
            "convention": self.convention,
        }


@dataclass(frozen=True, slots=True)
class SceneReceipt:
    kind: Literal["pose", "placement", "scale", "coverage", "corridor", "splat"]
    sha256: str
    accepted: bool
    reasons: tuple[str, ...] = ()
    measurements: tuple[ReceiptMeasurement, ...] = ()

    def __post_init__(self) -> None:
        _require_digest(self.sha256, f"{self.kind} receipt digest")
        if any(not reason for reason in self.reasons):
            raise ValueError("receipt reasons must be non-empty strings")

    def as_payload(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "sha256": self.sha256,
            "accepted": self.accepted,
            "reasons": list(self.reasons),
            "measurements": [measurement.as_payload() for measurement in self.measurements],
        }


@dataclass(frozen=True, slots=True)
class SceneGateInputs:
    pose: SceneReceipt
    placement: SceneReceipt
    registered_member_count: int
    member_count: int
    scale: SceneReceipt | None = None
    coverage: SceneReceipt | None = None
    corridor: SceneReceipt | None = None
    splat: SceneReceipt | None = None

    def __post_init__(self) -> None:
        if self.pose.kind != "pose" or self.placement.kind != "placement":
            raise ValueError("scene gate pose and placement receipts use the wrong kinds")
        for name in ("scale", "coverage", "corridor", "splat"):
            receipt = getattr(self, name)
            if receipt is not None and receipt.kind != name:
                raise ValueError(f"scene gate {name} receipt uses the wrong kind")
        if self.member_count <= 0:
            raise ValueError("a scene gate needs at least one member")
        if not 0 <= self.registered_member_count <= self.member_count:
            raise ValueError("registered member count is outside the scene")

    def receipts(self) -> tuple[SceneReceipt, ...]:
        return tuple(
            receipt
            for receipt in (
                self.pose,
                self.placement,
                self.scale,
                self.coverage,
                self.corridor,
                self.splat,
            )
            if receipt is not None
        )


@dataclass(frozen=True, slots=True)
class SceneGateDecision:
    rung: Literal[1, 2, 3, 4]
    member_count: int
    registered_member_count: int
    reasons: tuple[str, ...]
    receipts: tuple[SceneReceipt, ...]

    def payload(self) -> dict[str, object]:
        return {
            "profile": SCENE_GATE_PROFILE,
            "rung": self.rung,
            "member_count": self.member_count,
            "registered_member_count": self.registered_member_count,
            "reasons": list(self.reasons),
            "receipts": [receipt.as_payload() for receipt in self.receipts],
        }

    @property
    def digest(self) -> str:
        return _digest(_canonical(self.payload()))

    def to_bytes(self) -> bytes:
        return _canonical(
            {
                "profile": "orimera.reconstruction-scene-gate-envelope/v1",
                "decision_sha256": self.digest,
                "decision": self.payload(),
            }
        ) + b"\n"


def validate_scene_gate_decision(data: bytes) -> SceneGateDecision:
    """Read a gate envelope and independently reproduce the decision it records."""
    try:
        envelope = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("the scene gate receipt is not JSON") from error
    if (
        not isinstance(envelope, dict)
        or envelope.get("profile") != "orimera.reconstruction-scene-gate-envelope/v1"
    ):
        raise ValueError("the scene gate envelope version is unsupported")
    raw = envelope.get("decision")
    decision_digest = envelope.get("decision_sha256")
    if not isinstance(decision_digest, str) or _digest(_canonical(raw)) != decision_digest:
        raise ValueError("the scene gate decision disagrees with its digest")
    if not isinstance(raw, dict) or raw.get("profile") != SCENE_GATE_PROFILE:
        raise ValueError("the scene gate decision version is unsupported")

    rung = raw.get("rung")
    member_count = raw.get("member_count")
    registered_count = raw.get("registered_member_count")
    reasons = raw.get("reasons")
    raw_receipts = raw.get("receipts")
    if isinstance(rung, bool) or rung not in (1, 2, 3, 4):
        raise ValueError("the scene gate rung is outside the reconstruction ladder")
    if isinstance(member_count, bool) or not isinstance(member_count, int):
        raise ValueError("the scene gate member count is malformed")
    if isinstance(registered_count, bool) or not isinstance(registered_count, int):
        raise ValueError("the scene gate registered-member count is malformed")
    if not isinstance(reasons, list) or any(
        not isinstance(reason, str) or not reason for reason in reasons
    ):
        raise ValueError("the scene gate reasons are malformed")
    if not isinstance(raw_receipts, list):
        raise ValueError("the scene gate receipts are malformed")

    receipts: list[SceneReceipt] = []
    for raw_receipt in raw_receipts:
        if not isinstance(raw_receipt, dict):
            raise ValueError("a scene gate receipt is malformed")
        kind = raw_receipt.get("kind")
        if kind not in ("pose", "placement", "scale", "coverage", "corridor", "splat"):
            raise ValueError("a scene gate receipt kind is unsupported")
        accepted = raw_receipt.get("accepted")
        receipt_reasons = raw_receipt.get("reasons")
        raw_measurements = raw_receipt.get("measurements")
        if not isinstance(accepted, bool):
            raise ValueError("a scene gate receipt acceptance is malformed")
        if not isinstance(receipt_reasons, list) or any(
            not isinstance(reason, str) or not reason for reason in receipt_reasons
        ):
            raise ValueError("a scene gate receipt reason is malformed")
        if not isinstance(raw_measurements, list):
            raise ValueError("a scene gate receipt measurement list is malformed")
        measurements: list[ReceiptMeasurement] = []
        for raw_measurement in raw_measurements:
            if not isinstance(raw_measurement, dict):
                raise ValueError("a scene gate receipt measurement is malformed")
            value = raw_measurement.get("value")
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise ValueError("a scene gate receipt measurement value is malformed")
            measurements.append(
                ReceiptMeasurement(
                    name=str(raw_measurement.get("name", "")),
                    value=float(value),
                    unit=str(raw_measurement.get("unit", "")),
                    convention=str(raw_measurement.get("convention", "")),
                )
            )
        receipts.append(
            SceneReceipt(
                kind=kind,
                sha256=str(raw_receipt.get("sha256", "")),
                accepted=accepted,
                reasons=tuple(receipt_reasons),
                measurements=tuple(measurements),
            )
        )

    by_kind = {receipt.kind: receipt for receipt in receipts}
    if len(by_kind) != len(receipts) or "pose" not in by_kind or "placement" not in by_kind:
        raise ValueError("scene gate receipts must contain one pose and one placement receipt")
    inputs = SceneGateInputs(
        pose=by_kind["pose"],
        placement=by_kind["placement"],
        member_count=member_count,
        registered_member_count=registered_count,
        scale=by_kind.get("scale"),
        coverage=by_kind.get("coverage"),
        corridor=by_kind.get("corridor"),
        splat=by_kind.get("splat"),
    )
    reproduced = decide_scene_rung(inputs)
    recorded = SceneGateDecision(
        rung=rung,
        member_count=member_count,
        registered_member_count=registered_count,
        reasons=tuple(reasons),
        receipts=tuple(receipts),
    )
    if recorded != reproduced or recorded.digest != decision_digest:
        raise ValueError("the scene gate receipt does not reproduce its recorded decision")
    return recorded


def _accepted(receipt: SceneReceipt | None) -> bool:
    return receipt is not None and receipt.accepted


def decide_scene_rung(inputs: SceneGateInputs) -> SceneGateDecision:
    """Award the highest rung whose exact receipt chain is present and accepted."""
    receipts = inputs.receipts()
    reasons: list[str] = []

    # A rung-1 splat still needs validated scale and coverage. The splat controller independently
    # verifies pose and its own held-out thresholds; this gate composes that accepted receipt
    # rather than silently re-running it under another convention.
    if _accepted(inputs.scale) and _accepted(inputs.coverage) and _accepted(inputs.splat):
        return SceneGateDecision(
            rung=1,
            member_count=inputs.member_count,
            registered_member_count=inputs.registered_member_count,
            reasons=(),
            receipts=receipts,
        )
    if inputs.splat is None:
        reasons.append("Rung 1 withheld: no reviewed splat receipt is available.")
    elif not inputs.splat.accepted:
        reasons.extend(f"Rung 1 withheld: {reason}" for reason in inputs.splat.reasons)

    # A rung-2 corridor needs a physically validated scale, measured coverage and its own
    # collision/navigation acceptance. Posed relief is the current substrate, but placement by
    # itself does not grant movement along a path.
    if _accepted(inputs.scale) and _accepted(inputs.coverage) and _accepted(inputs.corridor):
        return SceneGateDecision(
            rung=2,
            member_count=inputs.member_count,
            registered_member_count=inputs.registered_member_count,
            reasons=tuple(reasons),
            receipts=receipts,
        )
    if inputs.scale is None:
        reasons.append("Rung 2 withheld: no physically validated scale receipt is available.")
    elif not inputs.scale.accepted:
        reasons.extend(f"Rung 2 withheld: {reason}" for reason in inputs.scale.reasons)
    if inputs.coverage is None:
        reasons.append("Rung 2 withheld: no measured coverage receipt is available.")
    elif not inputs.coverage.accepted:
        reasons.extend(f"Rung 2 withheld: {reason}" for reason in inputs.coverage.reasons)
    if inputs.corridor is None:
        reasons.append("Rung 2 withheld: no measured corridor receipt is available.")
    elif not inputs.corridor.accepted:
        reasons.extend(f"Rung 2 withheld: {reason}" for reason in inputs.corridor.reasons)

    if inputs.registered_member_count > 0 and inputs.placement.accepted:
        reasons.extend(f"Pose gate: {reason}" for reason in inputs.pose.reasons)
        return SceneGateDecision(
            rung=3,
            member_count=inputs.member_count,
            registered_member_count=inputs.registered_member_count,
            reasons=tuple(reasons),
            receipts=receipts,
        )
    reasons.append("Rung 3 withheld: no member point map has a recovered placement.")
    return SceneGateDecision(
        rung=4,
        member_count=inputs.member_count,
        registered_member_count=inputs.registered_member_count,
        reasons=tuple(reasons),
        receipts=receipts,
    )

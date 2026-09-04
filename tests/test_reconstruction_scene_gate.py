from __future__ import annotations

import json

import pytest
from orimera.reconstruction.scene_gate import (
    ReceiptMeasurement,
    SceneGateInputs,
    SceneReceipt,
    decide_scene_rung,
)


def _receipt(kind, character, *, accepted, reasons=(), measurements=()):
    return SceneReceipt(
        kind=kind,
        sha256=character * 64,
        accepted=accepted,
        reasons=tuple(reasons),
        measurements=tuple(measurements),
    )


def _current_inputs(**changes):
    values = {
        "pose": _receipt(
            "pose",
            "a",
            accepted=False,
            reasons=(
                "minimum registered-image fraction is unmeasured",
                "maximum mean reprojection error is unmeasured",
            ),
            measurements=(
                ReceiptMeasurement(
                    "registered_fraction",
                    0.75,
                    "ratio",
                    "registered manifest images divided by all manifest images",
                ),
            ),
        ),
        "placement": _receipt("placement", "b", accepted=True),
        "registered_member_count": 3,
        "member_count": 4,
    }
    values.update(changes)
    return SceneGateInputs(**values)


def test_the_present_gate_awards_rung_three_and_names_every_missing_receipt():
    decision = decide_scene_rung(_current_inputs())
    assert decision.rung == 3
    assert decision.member_count == 4
    assert decision.registered_member_count == 3
    assert decision.reasons == (
        "Rung 1 withheld: no reviewed splat receipt is available.",
        "Rung 2 withheld: no physically validated scale receipt is available.",
        "Rung 2 withheld: no measured coverage receipt is available.",
        "Rung 2 withheld: no measured corridor receipt is available.",
        "Pose gate: minimum registered-image fraction is unmeasured",
        "Pose gate: maximum mean reprojection error is unmeasured",
    )
    payload = json.loads(decision.to_bytes())
    assert payload["decision_sha256"] == decision.digest
    assert [receipt["kind"] for receipt in payload["decision"]["receipts"]] == [
        "pose",
        "placement",
    ]


def test_an_accepted_corridor_without_scale_or_coverage_cannot_award_rung_two():
    decision = decide_scene_rung(
        _current_inputs(corridor=_receipt("corridor", "c", accepted=True))
    )
    assert decision.rung == 3
    assert any("scale receipt" in reason for reason in decision.reasons)
    assert any("coverage receipt" in reason for reason in decision.reasons)


def test_an_accepted_receipt_chain_can_be_added_without_changing_rung_three_meaning():
    scale = _receipt(
        "scale",
        "c",
        accepted=True,
        measurements=(
            ReceiptMeasurement(
                "metres_per_unit",
                0.25,
                "metres per COLMAP unit",
                "reviewed physical calibration target",
            ),
        ),
    )
    coverage = _receipt("coverage", "d", accepted=True)
    corridor = _receipt("corridor", "e", accepted=True)
    assert decide_scene_rung(
        _current_inputs(scale=scale, coverage=coverage, corridor=corridor)
    ).rung == 2
    assert decide_scene_rung(
        _current_inputs(
            scale=scale,
            coverage=coverage,
            corridor=corridor,
            splat=_receipt("splat", "f", accepted=True),
        )
    ).rung == 1


def test_loaded_geometry_does_not_replace_a_missing_placement_receipt():
    decision = decide_scene_rung(
        _current_inputs(
            registered_member_count=3,
            placement=_receipt("placement", "b", accepted=False),
        )
    )
    assert decision.rung == 4
    assert decision.reasons[-1] == (
        "Rung 3 withheld: no member point map has a recovered placement."
    )


def test_every_number_requires_a_named_convention():
    with pytest.raises(ValueError, match="convention"):
        ReceiptMeasurement("registered_fraction", 0.75, "ratio", "")
    with pytest.raises(ValueError, match="finite"):
        ReceiptMeasurement("registered_fraction", float("nan"), "ratio", "manifest fraction")

from __future__ import annotations

from orimera.reconstruction.quality import PointMapQualityObservation, build_quality_report


def _observation(**changes):
    values = {
        "capture_ref": "capture-1",
        "artifact_sha256": "a" * 64,
        "rung": 3,
        "valid_fraction": 0.72,
        "metric": True,
        "opm_integrity": "passed",
        "playcanvas_consumption": "passed",
        "source_opened": "passed",
        "source_camera_visual_alignment": "passed",
        "deletion_closure": "passed",
        "byte_length": 4096,
        "production_duration_ms": 125.5,
        "browser_load_duration_ms": 11.25,
        "usd_cost": 0.0,
    }
    values.update(changes)
    return PointMapQualityObservation(**values)


def test_synthetic_contract_measurements_never_pass_the_real_corpus_gate():
    report = build_quality_report("synthetic", [_observation()])
    assert report.gate_passed is False
    assert any("consented real corpus" in reason for reason in report.blockers)
    assert report.distributions["valid_fraction"]["p50"] == 0.72


def test_missing_measurements_stay_missing_and_name_the_blocker():
    report = build_quality_report(
        "real-consented",
        [_observation(playcanvas_consumption="not-run", browser_load_duration_ms=None)],
    )
    assert report.gate_passed is False
    assert "browser_load_duration_ms" not in report.distributions
    assert any("playcanvas_consumption is not-run" in reason for reason in report.blockers)


def test_a_complete_real_observation_can_pass_without_changing_the_rung_threshold():
    report = build_quality_report("real-consented", [_observation()])
    assert report.gate_passed is True
    assert report.blockers == ()

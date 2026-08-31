from __future__ import annotations

from dataclasses import replace

import pytest
from orimera.reconstruction.navigation import (
    CorridorBuildManifest,
    Destination,
    NavigationPoseSample,
    build_corridor_artifact,
    validate_corridor_artifact,
)


def _sample(index: int, **changes) -> NavigationPoseSample:
    values = {
        "camera_ref": f"camera-{index}",
        "position_metres": (float(index), 0.0, 0.0),
        "forward": (1.0, 0.0, 0.0),
        "clearance_radius_metres": 1.2,
        "slope_degrees": 2.0,
        "source_vantage": index == 0,
        "recovery_pose": index == 0,
    }
    values.update(changes)
    return NavigationPoseSample(**values)


def _manifest(**changes) -> CorridorBuildManifest:
    values = {
        "scene_ref": "room-1",
        "reconstruction_digest": "a" * 64,
        "topology_digest": "b" * 64,
        "samples": tuple(_sample(index) for index in range(4)),
        "required_destinations": (Destination("far-wall", "camera-3"),),
        "agent_radius_metres": 0.3,
        "maximum_lateral_metres": 0.6,
        "maximum_pose_gap_metres": 1.5,
        "maximum_slope_degrees": 10.0,
        "maximum_look_yaw_degrees": 35.0,
        "minimum_look_pitch_degrees": -30.0,
        "maximum_look_pitch_degrees": 45.0,
    }
    values.update(changes)
    return CorridorBuildManifest(**values)


def test_measured_clearance_can_only_narrow_the_reviewed_lateral_cap():
    artifact = build_corridor_artifact(_manifest())
    assert artifact.accepted is True
    assert artifact.published_rung == 2
    assert artifact.lateral_half_widths == (0.6, 0.6, 0.6, 0.6)
    validate_corridor_artifact(
        artifact, reconstruction_digest="a" * 64, topology_digest="b" * 64
    )


def test_clearance_slope_gap_destination_and_recovery_failures_keep_rung_three():
    samples = (
        _sample(0, recovery_pose=False),
        _sample(1, clearance_radius_metres=0.1),
        _sample(4, slope_degrees=20),
    )
    artifact = build_corridor_artifact(
        _manifest(
            samples=samples,
            required_destinations=(Destination("missing", "not-a-camera"),),
        )
    )
    assert artifact.accepted is False
    assert artifact.published_rung == 3
    joined = " ".join(artifact.reasons)
    assert "clearance" in joined
    assert "slope" in joined
    assert "gap" in joined
    assert "destination" in joined
    assert "recovery" in joined


def test_artifact_is_bound_to_reconstruction_topology_and_its_own_bytes():
    artifact = build_corridor_artifact(_manifest())
    with pytest.raises(ValueError, match="topology"):
        validate_corridor_artifact(
            artifact, reconstruction_digest="a" * 64, topology_digest="c" * 64
        )
    with pytest.raises(ValueError, match="digest"):
        validate_corridor_artifact(
            replace(artifact, lateral_half_widths=(9.0, 9.0, 9.0, 9.0)),
            reconstruction_digest="a" * 64,
            topology_digest="b" * 64,
        )

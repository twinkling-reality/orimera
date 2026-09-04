from __future__ import annotations

import hashlib
import json

import pytest
from exulanica.reconstruction.placement import (
    PointMapInput,
    build_placement_record,
    validate_placement_record,
)


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _receipt() -> bytes:
    manifest = {
        "profile": "exulanica.colmap-pose-build/v1",
        "scene_ref": "scene-1",
        "code_revision": "a" * 40,
        "colmap_version": "pycolmap 4.2.0",
        "execution_image": "runtime@sha256:" + "b" * 64,
        "frames": [
            {
                "capture_ref": capture,
                "filename": f"{index:04d}.jpg",
                "sha256": character * 64,
                "capture_set": "group-1",
            }
            for index, (capture, character) in enumerate(
                (("capture-a", "1"), ("capture-b", "2"), ("capture-c", "3"))
            )
        ],
        "quality_thresholds": {
            "min_registered_fraction": None,
            "max_mean_reprojection_error_px": None,
            "min_camera_translation_units": None,
        },
        "metric_scale": None,
    }
    camera_convention = {
        "mapping": "camera_from_world",
        "camera_axes": {"right": "+X", "down": "+Y", "forward": "+Z"},
        "quaternion_order": "wxyz",
    }
    quality = {
        "source_count": 3,
        "registered_images": ["0000.jpg", "0002.jpg"],
        "cameras": [
            {
                "image_name": "0000.jpg",
                "convention": camera_convention,
                "quaternion_wxyz": [1, 0, 0, 0],
                "translation_xyz": [0, 0, 0],
                "camera_centre_xyz": [0, 0, 0],
            },
            {
                "image_name": "0002.jpg",
                "convention": camera_convention,
                "quaternion_wxyz": [1, 0, 0, 0],
                "translation_xyz": [-2, 0, 0],
                "camera_centre_xyz": [2, 0, 0],
            },
        ],
        "registered_fraction": 2 / 3,
        "mean_reprojection_error_px": 0.4,
        "camera_translation_extent_units": 2,
        "connected_model": "0",
        "jointly_coregistered": False,
        "shared_metric_frame": False,
        "metric_scale_metres_per_unit": None,
        "artifact_inventory": [],
        "accepted": False,
        "fallback_rung": 3,
        "reasons": [
            "minimum registered-image fraction is unmeasured",
            "maximum mean reprojection error is unmeasured",
            "minimum recovered camera translation is unmeasured",
        ],
    }
    return _canonical(
        {
            "profile": "exulanica.colmap-pose-receipt/v2",
            "manifest_digest": hashlib.sha256(_canonical(manifest)).hexdigest(),
            "manifest": manifest,
            "quality_digest": hashlib.sha256(_canonical(quality)).hexdigest(),
            "quality": quality,
        }
    ) + b"\n"


def _maps() -> dict[str, PointMapInput]:
    return {
        "capture-a": PointMapInput("capture-a", "artifact-a", "a" * 64),
        "capture-c": PointMapInput("capture-c", "artifact-c", "c" * 64),
    }


def _record():
    return build_placement_record(
        scene_ref="scene-1",
        pose_receipt=_receipt(),
        member_capture_refs=("capture-a", "capture-b", "capture-c"),
        point_maps=_maps(),
    )


def _rewrite(data: bytes, change) -> bytes:
    envelope = json.loads(data)
    change(envelope["placement"])
    envelope["payload_sha256"] = hashlib.sha256(
        _canonical(envelope["placement"])
    ).hexdigest()
    return _canonical(envelope) + b"\n"


def test_placement_is_deterministic_and_keeps_exact_member_order():
    first = _record()
    second = _record()
    assert first.to_bytes() == second.to_bytes()
    assert first.member_capture_refs == ("capture-a", "capture-b", "capture-c")
    assert [member.capture_ref for member in first.placed] == ["capture-a", "capture-c"]
    assert first.excluded[0].as_payload() == {
        "capture_ref": "capture-b",
        "registered": False,
        "reason": "pose-not-registered",
    }


def test_transform_converts_opm_axes_and_places_the_recovered_camera():
    first, second = _record().placed
    assert first.scene_from_opm == (
        1, 0, 0, 0,
        0, -1, 0, 0,
        0, 0, -1, 0,
        0, 0, 0, 1,
    )
    assert second.scene_from_opm[3:12:4] == (2, 0, 0)
    assert second.local_units_to_scene_units == 1
    assert second.scale_status == "unvalidated-identity"


def test_validation_accepts_only_the_record_current_inputs_reproduce():
    record = _record()
    assert validate_placement_record(
        record.to_bytes(),
        expected_scene_ref="scene-1",
        pose_receipt=_receipt(),
        member_capture_refs=("capture-a", "capture-b", "capture-c"),
        point_maps=_maps(),
    ) == record


def test_changed_point_map_digest_makes_the_placement_stale():
    changed = _maps()
    changed["capture-c"] = PointMapInput("capture-c", "artifact-c", "d" * 64)
    with pytest.raises(ValueError, match="current inputs"):
        validate_placement_record(
            _record().to_bytes(),
            expected_scene_ref="scene-1",
            pose_receipt=_receipt(),
            member_capture_refs=("capture-a", "capture-b", "capture-c"),
            point_maps=changed,
        )


def test_duplicate_or_missing_member_outcomes_are_refused():
    duplicate = _rewrite(
        _record().to_bytes(),
        lambda payload: payload["excluded"].append(payload["excluded"][0]),
    )
    with pytest.raises(ValueError, match="exactly one"):
        validate_placement_record(
            duplicate,
            expected_scene_ref="scene-1",
            pose_receipt=_receipt(),
            member_capture_refs=("capture-a", "capture-b", "capture-c"),
            point_maps=_maps(),
        )


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda payload: payload["placed"][0].__setitem__(
                "scene_from_opm_row_major", [1, 0, 0, 0] * 4
            ),
            "affine",
        ),
        (
            lambda payload: payload["placed"][0].__setitem__(
                "scene_from_opm_row_major", [2, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]
            ),
            "orthonormal",
        ),
        (
            lambda payload: payload.__setitem__(
                "profile", "exulanica.posed-point-map-placement/v2"
            ),
            "version",
        ),
    ],
)
def test_invalid_transform_and_format_versions_are_refused(mutate, message):
    damaged = _rewrite(_record().to_bytes(), mutate)
    with pytest.raises(ValueError, match=message):
        validate_placement_record(
            damaged,
            expected_scene_ref="scene-1",
            pose_receipt=_receipt(),
            member_capture_refs=("capture-a", "capture-b", "capture-c"),
            point_maps=_maps(),
        )


def test_a_point_map_from_outside_the_scene_is_refused():
    point_maps = _maps()
    point_maps["capture-x"] = PointMapInput("capture-x", "artifact-x", "e" * 64)
    with pytest.raises(ValueError, match="outside the scene"):
        build_placement_record(
            scene_ref="scene-1",
            pose_receipt=_receipt(),
            member_capture_refs=("capture-a", "capture-b", "capture-c"),
            point_maps=point_maps,
        )

"""Strict validation for the bytes handed to the Atlas point-map reader.

Writing a valid-looking JSON header is not enough.  The renderer constructs typed-array views over
the offsets in that header, so a bad length is an out-of-bounds read and a plausible but wrong
camera convention is a spatial lie.  This module validates the complete container without knowing
anything about evidence, storage, or the database.  The ingest layer remains responsible for the
separate assertion that links an artifact to the source evidence it was derived from.

The alignment result below is *container alignment*: the declared source size, field of view,
camera origin, axes, and recovered points agree.  It is not a claim that a human inspected the
render against a private source photograph.  A real-corpus report must record that separately.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
from dataclasses import dataclass
from typing import Any, Final

from orimera.reconstruction.opm import OPM_MAGIC, OPM_VERSION

__all__ = ["OpmIntegrityError", "OpmIntegrityReport", "validate_opm"]

_MAX_HEADER_BYTES: Final = 1_048_576
_EXPECTED_SECTIONS: Final = (
    ("position", "float32", 3, False, 12),
    ("color", "uint8", 4, True, 4),
    ("segment", "uint16", 1, False, 2),
)


class OpmIntegrityError(ValueError):
    """The container cannot be consumed without changing or guessing its meaning."""


@dataclass(frozen=True, slots=True)
class OpmIntegrityReport:
    sha256: str
    byte_length: int
    point_count: int
    metric: bool
    source_size: tuple[int, int]
    fov_y_degrees: float
    aspect: float
    bounds: tuple[tuple[float, float, float], tuple[float, float, float]]
    planar_contiguous: bool
    source_camera_contract_aligned: bool

    def as_payload(self) -> dict[str, object]:
        return {
            "profile": "orimera.opm-integrity/v1",
            "sha256": self.sha256,
            "byte_length": self.byte_length,
            "point_count": self.point_count,
            "metric": self.metric,
            "source_size": list(self.source_size),
            "fov_y_degrees": self.fov_y_degrees,
            "aspect": self.aspect,
            "bounds": {"min": list(self.bounds[0]), "max": list(self.bounds[1])},
            "planar_contiguous": self.planar_contiguous,
            # Structural validation only. A real source/render inspection is a separate field in
            # the corpus quality report and is never inferred from this value.
            "source_camera_contract_aligned": self.source_camera_contract_aligned,
        }


def _mapping(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpmIntegrityError(f"{field} must be an object")
    return value


def _finite_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise OpmIntegrityError(f"{field} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise OpmIntegrityError(f"{field} must be a finite number")
    return number


def _vector(value: object, field: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise OpmIntegrityError(f"{field} must be a three-number array")
    return tuple(_finite_number(item, f"{field}[{index}]") for index, item in enumerate(value))  # type: ignore[return-value]


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise OpmIntegrityError(f"{field} must be a positive integer")
    return value


def validate_opm(data: bytes) -> OpmIntegrityReport:
    """Validate the complete OPM/1 container and return only measured facts.

    Empty point maps are allowed because they are the honest result for an unplaceable frame.  An
    empty map cannot be published as rung 3: the quality gate makes that decision outside this
    file.  Integrity and quality are deliberately separate predicates.
    """
    if len(data) < 8 or data[:4] != OPM_MAGIC:
        raise OpmIntegrityError("not an OPM/1 container")
    header_length = int.from_bytes(data[4:8], "little")
    if header_length <= 0 or header_length > _MAX_HEADER_BYTES or 8 + header_length > len(data):
        raise OpmIntegrityError("the OPM header length is outside the container")
    try:
        parsed = json.loads(data[8 : 8 + header_length])
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OpmIntegrityError("the OPM header is not valid UTF-8 JSON") from exc
    header = _mapping(parsed, "header")

    if header.get("format") != "orimera-point-map" or header.get("version") != OPM_VERSION:
        raise OpmIntegrityError("the OPM format or version is unsupported")
    if header.get("rung") != 3:
        raise OpmIntegrityError("an OPM point map must declare rung 3")
    if (header.get("frame"), header.get("up"), header.get("forward"), header.get("units")) != (
        "local",
        "+Y",
        "-Z",
        "metres",
    ):
        raise OpmIntegrityError("the OPM local-frame convention is incomplete or unsupported")
    if not isinstance(header.get("metric"), bool):
        raise OpmIntegrityError("metric must be an explicit boolean")
    if header.get("colorAlpha") != "confidence":
        raise OpmIntegrityError("the color alpha channel must be declared as confidence")

    count = header.get("pointCount")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise OpmIntegrityError("pointCount must be a non-negative integer")

    source = _mapping(header.get("sourceImage"), "sourceImage")
    source_size = (
        _positive_integer(source.get("width"), "sourceImage.width"),
        _positive_integer(source.get("height"), "sourceImage.height"),
    )
    viewpoint = _mapping(header.get("viewpoint"), "viewpoint")
    position = _vector(viewpoint.get("position"), "viewpoint.position")
    forward = _vector(viewpoint.get("forward"), "viewpoint.forward")
    up = _vector(viewpoint.get("up"), "viewpoint.up")
    fov = _finite_number(viewpoint.get("fovYDeg"), "viewpoint.fovYDeg")
    aspect = _finite_number(viewpoint.get("aspect"), "viewpoint.aspect")
    if position != (0.0, 0.0, 0.0) or forward != (0.0, 0.0, -1.0) or up != (0.0, 1.0, 0.0):
        raise OpmIntegrityError("a monocular OPM viewpoint must be the source-camera frame")
    if not 1.0 <= fov < 179.0:
        raise OpmIntegrityError("viewpoint.fovYDeg is outside the open camera range")
    expected_aspect = source_size[0] / source_size[1]
    if aspect <= 0 or not math.isclose(aspect, expected_aspect, rel_tol=1e-6, abs_tol=1e-9):
        raise OpmIntegrityError("viewpoint.aspect does not match sourceImage")

    sections_value = header.get("sections")
    if not isinstance(sections_value, list) or len(sections_value) != 3:
        raise OpmIntegrityError("OPM/1 requires exactly three sections")
    offsets: list[int] = []
    lengths: list[int] = []
    for raw, expected in zip(sections_value, _EXPECTED_SECTIONS, strict=True):
        section = _mapping(raw, "section")
        name, kind, components, normalized, stride = expected
        if (
            section.get("name"),
            section.get("type"),
            section.get("components"),
            section.get("normalized"),
        ) != (name, kind, components, normalized):
            raise OpmIntegrityError(f"the {name} section layout is invalid")
        offset = section.get("byteOffset")
        length = section.get("byteLength")
        if (
            isinstance(offset, bool)
            or not isinstance(offset, int)
            or isinstance(length, bool)
            or not isinstance(length, int)
            or offset < 8 + header_length
            or length != count * stride
            or offset + length > len(data)
        ):
            raise OpmIntegrityError(f"the {name} section range is invalid")
        offsets.append(offset)
        lengths.append(length)
    if offsets[0] % 4 or offsets[2] % 2:
        raise OpmIntegrityError("OPM section offsets are not typed-array aligned")
    contiguous = offsets[1] == offsets[0] + lengths[0] and offsets[2] == offsets[1] + lengths[1]
    if not contiguous:
        raise OpmIntegrityError("production OPM sections must be planar-contiguous")
    if offsets[2] + lengths[2] != len(data):
        raise OpmIntegrityError("bytes follow the final OPM section")

    low = _vector(_mapping(header.get("bounds"), "bounds").get("min"), "bounds.min")
    high = _vector(_mapping(header.get("bounds"), "bounds").get("max"), "bounds.max")
    if any(a > b for a, b in zip(low, high, strict=True)):
        raise OpmIntegrityError("the OPM bounds are inverted")

    if count:
        values = struct.iter_unpack("<fff", memoryview(data)[offsets[0] : offsets[0] + lengths[0]])
        actual_low = [math.inf, math.inf, math.inf]
        actual_high = [-math.inf, -math.inf, -math.inf]
        for point in values:
            if not all(math.isfinite(component) for component in point):
                raise OpmIntegrityError("the position section contains a non-finite point")
            if point[2] >= 0:
                raise OpmIntegrityError("a recovered point is not in front of the source camera")
            for axis, component in enumerate(point):
                actual_low[axis] = min(actual_low[axis], component)
                actual_high[axis] = max(actual_high[axis], component)
        for declared, actual in zip((*low, *high), (*actual_low, *actual_high), strict=True):
            if not math.isclose(declared, actual, rel_tol=1e-6, abs_tol=1e-5):
                raise OpmIntegrityError("declared OPM bounds do not enclose the stored positions")
    elif low != (0.0, 0.0, 0.0) or high != (0.0, 0.0, 0.0):
        raise OpmIntegrityError("an empty OPM must have degenerate origin bounds")

    segments_value = header.get("segments")
    if not isinstance(segments_value, list):
        raise OpmIntegrityError("segments must be an array")
    segment_ids: set[int] = set()
    for raw in segments_value:
        segment = _mapping(raw, "segment")
        identifier = segment.get("id")
        if (
            isinstance(identifier, bool)
            or not isinstance(identifier, int)
            or not 0 <= identifier <= 65535
        ):
            raise OpmIntegrityError("segment ids must be unique uint16 values")
        if identifier in segment_ids:
            raise OpmIntegrityError("segment ids must be unique uint16 values")
        segment_ids.add(identifier)
    for (identifier,) in struct.iter_unpack(
        "<H", memoryview(data)[offsets[2] : offsets[2] + lengths[2]]
    ):
        if identifier not in segment_ids:
            raise OpmIntegrityError("a point names an undeclared segment")

    return OpmIntegrityReport(
        sha256=hashlib.sha256(data).hexdigest(),
        byte_length=len(data),
        point_count=count,
        metric=header["metric"],
        source_size=source_size,
        fov_y_degrees=fov,
        aspect=aspect,
        bounds=(low, high),
        planar_contiguous=True,
        source_camera_contract_aligned=True,
    )

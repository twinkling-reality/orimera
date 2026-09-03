"""Strict validation for the bytes handed to the Atlas point-map reader.

Writing a valid-looking JSON header is not enough.  The renderer constructs typed-array views over
the offsets in that header, so a bad length is an out-of-bounds read and a plausible but wrong
camera convention is a spatial lie.  This module validates the complete container without knowing
anything about evidence, storage, or the database.  The ingest layer remains responsible for the
separate assertion that links an artifact to the source evidence it was derived from.

The alignment result below is *container alignment*: the declared source size, field of view,
camera origin, axes, and recovered points agree.  It is not a claim that a human inspected the
render against a private source photograph.  A real-corpus report must record that separately.

**This validates OPM/2 and refuses OPM/1 by name.** ADR-0010 D9 is refuse and regenerate: there
is no upgrade-on-read, because nothing in production held a file to upgrade when the version was
cut, and a converter would be a second reader of the old layout that nothing would exercise
again. What a caller gets instead is a message that says which version arrived and what produces
the new one.

**Nothing here restates the container.** The section table lives once, in
:mod:`orimera.reconstruction.opm`, and every stride, every element size and the order the
sections are packed in is read from it. Under OPM/1 this module carried its own copy of the three
sections and their strides, which is what made the header's generic section list a fiction:
ADR-0010 D2 makes the list authoritative, and a validator with a private copy of it would be the
one place that could not tell.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
from dataclasses import dataclass
from typing import Any, Final

from orimera.reconstruction.opm import (
    OPM_MAGIC,
    OPM_SECTIONS,
    OPM_VERSION,
    SUPERSEDED_OPM_VERSION,
)
from orimera.reconstruction.pointmap import MAX_SEGMENT_ID, RESERVED_TAG_FLAGS

__all__ = ["OpmIntegrityError", "OpmIntegrityReport", "validate_opm"]

_MAX_HEADER_BYTES: Final = 1_048_576

#: What ``colorAlpha`` may say. ADR-0010 D5: an enum rather than one constant that one of the two
#: writers had stopped meaning.
_COLOR_ALPHA: Final = frozenset({"support", "confidence"})

#: The section names a valid container must carry, in the order their bytes appear.
_REQUIRED_SECTIONS: Final = tuple(section.name for section in OPM_SECTIONS)
_BY_NAME: Final = {section.name: section for section in OPM_SECTIONS}


class OpmIntegrityError(ValueError):
    """The container cannot be consumed without changing or guessing its meaning."""


@dataclass(frozen=True, slots=True)
class OpmIntegrityReport:
    sha256: str
    byte_length: int
    point_count: int
    metric: bool
    source_size: tuple[int, int]
    #: The grid the points were unprojected from, which is not the photograph. See
    #: :func:`_model_grid_is_reachable`.
    model_size: tuple[int, int]
    fov_y_degrees: float
    aspect: float
    #: ``support`` or ``confidence``, carried rather than assumed, so a consumer of this report
    #: knows which quantity the alpha channel held without opening the file again.
    color_alpha: str
    bounds: tuple[tuple[float, float, float], tuple[float, float, float]]
    planar_contiguous: bool
    source_camera_contract_aligned: bool
    #: How many points declare that a four-neighbour was dropped by the silhouette test. Counted
    #: because the whole justification for the flag is a measurement nobody has taken yet:
    #: ADR-0010 D4 says bit 0 addresses "about a tenth of a percent of points" on the one map it
    #: was measured on, and a validator that walks every point anyway can say so per file.
    one_sided_points: int

    def as_payload(self) -> dict[str, object]:
        return {
            "profile": "orimera.opm-integrity/v2",
            "sha256": self.sha256,
            "byte_length": self.byte_length,
            "point_count": self.point_count,
            "metric": self.metric,
            "source_size": list(self.source_size),
            "model_size": list(self.model_size),
            "fov_y_degrees": self.fov_y_degrees,
            "aspect": self.aspect,
            "color_alpha": self.color_alpha,
            "bounds": {"min": list(self.bounds[0]), "max": list(self.bounds[1])},
            "planar_contiguous": self.planar_contiguous,
            "one_sided_points": self.one_sided_points,
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


def _pixel_size(value: object, field: str) -> tuple[int, int]:
    grid = _mapping(value, field)
    return (
        _positive_integer(grid.get("width"), f"{field}.width"),
        _positive_integer(grid.get("height"), f"{field}.height"),
    )


def _model_grid_is_reachable(source: tuple[int, int], model: tuple[int, int]) -> bool:
    """Could this model grid have come from this photograph by one uniform resize?

    ADR-0010 D6 requires ``modelImage`` and ``sourceImage`` to be checked "for consistency rather
    than for equality", and it requires the tolerance to be "derived from how the model rounds
    both dimensions independently rather than assumed to be one row". This is that derivation,
    and it needs no tolerance constant at all.

    A depth model scales the photograph by one factor and rounds each dimension to whole pixels
    on its own: ``(round(W * s), round(H * s))``, clamped up to 1. So a declared grid is
    reachable exactly when some real scale ``s`` could have produced both numbers, which is a
    question about whether two closed intervals overlap:

        s must lie in [(w - 0.5) / W, (w + 0.5) / W] and in [(h - 0.5) / H, (h + 0.5) / H]

    Nothing here assumes the longest edge came out exact, although for both models in this
    repository it does, because that is a property of one resize helper rather than of the
    format. Nothing here assumes the rounding direction either: half-up and half-to-even both
    satisfy the same bound, which is what lets the Python and TypeScript validators agree on the
    boundary case without sharing code.

    A dimension of 1 is the clamp rather than a rounding, so its lower bound opens: a 3000x40
    photograph at a 512 px longest edge rounds the short side to 7, but a 3000x2 one clamps to 1
    from 0.34, and refusing that would refuse a real photograph for being thin.
    """

    def window(declared: int, original: int) -> tuple[float, float]:
        upper = (declared + 0.5) / original
        if declared <= 1:
            return (0.0, upper)
        return ((declared - 0.5) / original, upper)

    low_w, high_w = window(model[0], source[0])
    low_h, high_h = window(model[1], source[1])
    return max(low_w, low_h) <= min(high_w, high_h)


def validate_opm(data: bytes) -> OpmIntegrityReport:
    """Validate the complete OPM/2 container and return only measured facts.

    Empty point maps are allowed because they are the honest result for an unplaceable frame.  An
    empty map cannot be published as rung 3: the quality gate makes that decision outside this
    file.  Integrity and quality are deliberately separate predicates.
    """
    if len(data) < 8 or data[:4] != OPM_MAGIC:
        raise OpmIntegrityError("not an OPM container")
    header_length = int.from_bytes(data[4:8], "little")
    if header_length <= 0 or header_length > _MAX_HEADER_BYTES or 8 + header_length > len(data):
        raise OpmIntegrityError("the OPM header length is outside the container")
    try:
        parsed = json.loads(data[8 : 8 + header_length])
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OpmIntegrityError("the OPM header is not valid UTF-8 JSON") from exc
    header = _mapping(parsed, "header")

    if header.get("format") != "orimera-point-map":
        raise OpmIntegrityError("the OPM format is unsupported")
    if header.get("version") == SUPERSEDED_OPM_VERSION:
        # By name, per ADR-0010 D9, and naming the path rather than the problem. There is no
        # converter to point at: the container version rides in the depth stage's params, so it
        # is inside the idempotency key, so re-running ingest writes a new artifact rather than
        # rewriting this one.
        raise OpmIntegrityError(
            f"this is an OPM/{SUPERSEDED_OPM_VERSION} container and this build reads "
            f"OPM/{OPM_VERSION}. There is no upgrade on read: re-run the depth stage over the "
            "source photograph, which regenerates the point map under a new idempotency key"
        )
    if header.get("version") != OPM_VERSION:
        raise OpmIntegrityError(
            f"the OPM version {header.get('version')!r} is unsupported; this build reads "
            f"OPM/{OPM_VERSION}"
        )
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
    color_alpha = header.get("colorAlpha")
    if color_alpha not in _COLOR_ALPHA:
        raise OpmIntegrityError(
            "colorAlpha must declare what the alpha channel holds, "
            f"one of {sorted(_COLOR_ALPHA)}, and it said {color_alpha!r}"
        )

    count = header.get("pointCount")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise OpmIntegrityError("pointCount must be a non-negative integer")

    source_size = _pixel_size(header.get("sourceImage"), "sourceImage")
    model_size = _pixel_size(header.get("modelImage"), "modelImage")
    if not _model_grid_is_reachable(source_size, model_size):
        raise OpmIntegrityError(
            f"modelImage {model_size[0]}x{model_size[1]} cannot be a uniform resize of "
            f"sourceImage {source_size[0]}x{source_size[1]}"
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

    offsets, lengths = _sections(header, data, header_length, count)

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

    one_sided = _tags(header, data, offsets[2], lengths[2])

    return OpmIntegrityReport(
        sha256=hashlib.sha256(data).hexdigest(),
        byte_length=len(data),
        point_count=count,
        metric=header["metric"],
        source_size=source_size,
        model_size=model_size,
        fov_y_degrees=fov,
        aspect=aspect,
        color_alpha=str(color_alpha),
        bounds=(low, high),
        planar_contiguous=True,
        source_camera_contract_aligned=True,
        one_sided_points=one_sided,
    )


def _sections(
    header: dict[str, Any], data: bytes, header_length: int, count: int
) -> tuple[list[int], list[int]]:
    """Every required section's byte range, checked against the table rather than against a copy.

    **An unrecognised section is carried and ignored rather than refused**, and that tolerance is
    the whole of ADR-0010 D2. "A registered optional section is not a version bump" is only true
    if a reader that has never heard of a section can still read the ones it knows; a validator
    that refused an unknown name would make every future attribute another version, which is the
    thing this version exists to be the last of. What is NOT tolerated is a known name with an
    unknown shape, a duplicate name, a range outside the file, or a byte between the required
    sections.
    """
    sections_value = header.get("sections")
    if not isinstance(sections_value, list):
        raise OpmIntegrityError("sections must be an array")
    seen: dict[str, tuple[int, int]] = {}
    end = 8 + header_length
    for raw in sections_value:
        section = _mapping(raw, "section")
        name = section.get("name")
        if not isinstance(name, str) or not name:
            raise OpmIntegrityError("every OPM section must be named")
        if name in seen:
            raise OpmIntegrityError(f"the {name} section is declared twice")
        offset = section.get("byteOffset")
        length = section.get("byteLength")
        if (
            isinstance(offset, bool)
            or not isinstance(offset, int)
            or isinstance(length, bool)
            or not isinstance(length, int)
            or offset < 8 + header_length
            or length < 0
            or offset + length > len(data)
        ):
            raise OpmIntegrityError(f"the {name} section range is invalid")
        expected = _BY_NAME.get(name)
        if expected is not None:
            if (
                section.get("type"),
                section.get("components"),
                section.get("normalized"),
            ) != (expected.type, expected.components, expected.normalized):
                raise OpmIntegrityError(f"the {name} section layout is invalid")
            if length != count * expected.stride:
                raise OpmIntegrityError(f"the {name} section range is invalid")
            if offset % expected.element_bytes:
                raise OpmIntegrityError(
                    f"the {name} section offset is not {expected.type} aligned"
                )
        seen[name] = (offset, length)
        end = max(end, offset + length)

    missing = [name for name in _REQUIRED_SECTIONS if name not in seen]
    if missing:
        raise OpmIntegrityError(f"the OPM is missing its {', '.join(missing)} section")

    offsets = [seen[name][0] for name in _REQUIRED_SECTIONS]
    lengths = [seen[name][1] for name in _REQUIRED_SECTIONS]
    for index in range(1, len(offsets)):
        if offsets[index] != offsets[index - 1] + lengths[index - 1]:
            raise OpmIntegrityError("production OPM sections must be planar-contiguous")
    if end != len(data):
        raise OpmIntegrityError("bytes follow the final OPM section")
    return offsets, lengths


def _tags(header: dict[str, Any], data: bytes, offset: int, length: int) -> int:
    """The two channels of the tags section, and the count of one-sided points.

    One pass for both channels, which is the pass OPM/1 already made over the segment section.
    The segment id must be declared AND inside the range the renderer can index, which are two
    different refusals: a file may declare a segment nothing in the renderer's table can present,
    and a point may name a segment the file never declared.
    """
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
            or not 0 <= identifier <= MAX_SEGMENT_ID
        ):
            raise OpmIntegrityError(
                f"a segment id must be unique and between 0 and {MAX_SEGMENT_ID}, which is what "
                "the renderer's semantic table holds and its shaders can index"
            )
        if identifier in segment_ids:
            raise OpmIntegrityError(
                f"a segment id must be unique and between 0 and {MAX_SEGMENT_ID}, which is what "
                "the renderer's semantic table holds and its shaders can index"
            )
        segment_ids.add(identifier)

    one_sided = 0
    for identifier, flags in struct.iter_unpack("<HH", memoryview(data)[offset : offset + length]):
        if identifier not in segment_ids:
            raise OpmIntegrityError("a point names an undeclared segment")
        if flags & RESERVED_TAG_FLAGS:
            raise OpmIntegrityError(
                "a reserved bit of the tags flags channel is set. The remaining fifteen bits are "
                "validated zero so that the next flag widens a declared word rather than "
                "reinterpreting bytes an older writer already filled"
            )
        one_sided += flags & 1
    return one_sided

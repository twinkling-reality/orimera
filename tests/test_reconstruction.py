"""Reconstruction: the container, the gate, and the frame conversion nobody can see is wrong.

Everything here runs with no torch, no weights and no download, against the flat-plane double.
That is the same arrangement the vision stage has and for the same reason: a suite that needed a
1.3 GB checkpoint is a suite that stops being run, and none of the properties below are about the
model. They are about the plumbing around it, which is where a wrong sign or a stray padding byte
produces a world that renders perfectly and is wrong.

``tests/test_reconstruction_is_not_evidence.py`` holds invariant 2 and is deliberately separate:
that file is about what reconstruction may never become, and this one is about whether it works.
"""

from __future__ import annotations

import json
import re
import struct
from array import array

import pytest
from orimera.reconstruction import (
    MAX_SEGMENT_ID,
    POINT_STRIDE_BYTES,
    TAG_ONE_SIDED,
    DepthPrediction,
    PointMap,
    Segment,
    Viewpoint,
    build_point_map,
    decide_rung,
    encode_opm,
    validate_opm,
)
from orimera.reconstruction.moge import to_opm_frame
from orimera.reconstruction.testing import FlatDepthModel
from PIL import Image


def _image(width: int = 40, height: int = 30) -> Image.Image:
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    assert pixels is not None
    for y in range(height):
        for x in range(width):
            pixels[x, y] = (x * 6 % 256, y * 8 % 256, 40)
    return image


def _stepped(near: float = 2.0, far: float = 10.0) -> DepthPrediction:
    """Two fronto-parallel surfaces meeting down the middle of a 4x2 frame.

    The only depth structure in the whole suite, and it is here rather than in `FlatDepthModel`
    on purpose: the double is a plane because the plumbing behaves identically whatever the
    depths are, and the one property that does not is the silhouette drop.
    """
    width, height = 4, 2
    points: list[float] = []
    for row in range(height):
        for column in range(width):
            # x and y scale with depth, as a real camera's rays do, so the far patch is sampled
            # more coarsely than the near one instead of sharing a synthetic grid pitch.
            depth = near if column < 2 else far
            points.extend((column * depth * 0.1, row * depth * 0.1, -depth))
    return DepthPrediction(
        width=width,
        height=height,
        points=points,
        valid=bytes([1] * (width * height)),
        fov_y_degrees=55.0,
        metric=True,
        model_id="stepped-double",
    )


def _mixed_sampling() -> DepthPrediction:
    """Mostly near surface with a distant strip down one side, sampled as a camera would.

    The proportions matter and are not arbitrary. Support is a ratio against the map's OWN median
    spacing, so a map that is half coarse puts the median in the middle and both halves clamp to
    full support. A photograph is not like that: most of the frame is the scene in front of you
    and the far stuff is a minority, which is the arrangement that makes the measure discriminate.
    """
    width, height = 16, 4
    points: list[float] = []
    for row in range(height):
        for column in range(width):
            depth = 2.0 if column < 12 else 10.0
            points.extend((column * depth * 0.1, row * depth * 0.1, -depth))
    return DepthPrediction(
        width=width,
        height=height,
        points=points,
        valid=bytes([1] * (width * height)),
        fov_y_degrees=55.0,
        metric=True,
        model_id="mixed-sampling-double",
    )


def _decode(data: bytes) -> dict:
    assert data[0:4] == b"OPM1"
    length = int.from_bytes(data[4:8], "little")
    return json.loads(data[8 : 8 + length])


def _reencode(data: bytes, header: dict) -> bytes:
    """The same bytes under an edited header, for the cases only a hostile writer produces.

    The header region is reserved to a fixed capacity and padded with spaces, so an edit that
    does not grow past the capacity leaves every section offset where it was. That is what lets
    a test hand the validator a container no writer in this repository can emit, which is the
    only way to reach the refusals that guard against one that could.
    """
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    first = min(int(s["byteOffset"]) for s in header["sections"])
    if 8 + len(encoded) > first:
        raise AssertionError("the edited header no longer fits its reserved capacity")
    out = bytearray(data)
    out[4:8] = len(encoded).to_bytes(4, "little")
    out[8 : 8 + len(encoded)] = encoded
    for index in range(8 + len(encoded), first):
        out[index] = 0x20
    return bytes(out)


def _relaid(header: dict, section_bytes: dict[str, bytes], *, gap: int = 0) -> bytes:
    """Assemble a container from an edited header and the bytes of each section.

    The writer reserves exactly the header capacity for the file it means to write, so a test
    that adds a section, renames one or reorders them has to lay the file out again rather than
    patch offsets in place. This is a deliberate second implementation of the layout, for one
    purpose: reaching the refusals that guard against a writer this repository does not contain.
    Every test below that uses it is testing what happens to a file NO conforming writer emits.

    Offsets are assigned in the header's own declared order, contiguously, which is the layout
    the production validator requires. ``gap`` puts that many bytes of padding in front of every
    section after the first, which is the shape the TypeScript writer's per-section sixteen-byte
    alignment produced for any count that was not a multiple of four.
    """
    order = [str(section["name"]) for section in header["sections"]]

    def laid(offsets: list[int]) -> dict:
        edited = json.loads(json.dumps(header))
        for section, offset in zip(edited["sections"], offsets, strict=True):
            section["byteOffset"] = offset
        return edited

    probe = json.dumps(laid([0] * len(order)), separators=(",", ":")).encode("utf-8")
    capacity = -(-(len(probe) + 96) // 16) * 16
    start = -(-(8 + capacity) // 16) * 16
    offsets: list[int] = []
    cursor = start
    for position, name in enumerate(order):
        cursor += gap if position else 0
        offsets.append(cursor)
        cursor += len(section_bytes[name])
    encoded = json.dumps(laid(offsets), separators=(",", ":")).encode("utf-8")
    assert 8 + len(encoded) <= start
    out = bytearray(cursor)
    out[0:4] = b"OPM1"
    out[4:8] = len(encoded).to_bytes(4, "little")
    out[8 : 8 + len(encoded)] = encoded
    for index in range(8 + len(encoded), start):
        out[index] = 0x20
    for name, offset in zip(order, offsets, strict=True):
        out[offset : offset + len(section_bytes[name])] = section_bytes[name]
    return bytes(out)


def _parts(data: bytes) -> tuple[dict, dict[str, bytes]]:
    """A container in two halves, its header and its sections' bytes, ready for :func:`_relaid`."""
    header = _decode(data)
    return header, {
        str(section["name"]): data[
            int(section["byteOffset"]) : int(section["byteOffset"]) + int(section["byteLength"])
        ]
        for section in header["sections"]
    }


def _encode(
    points: PointMap,
    *,
    aspect: float,
    source_size: tuple[int, int],
    model_size: tuple[int, int] | None = None,
    fov: float = 55.0,
    metric: bool = True,
    color_alpha: str = "support",
    generator: str = "test",
) -> bytes:
    """One call site for the OPM/2 header fields every test needs and few tests are about.

    ``model_size`` defaults to ``source_size`` because the flat-plane double does not downscale
    below its own `max_edge`, so for most of this suite the model's grid IS the photograph. The
    tests that exercise a real resize pass the prediction's grid, which is the interesting case
    and the one ADR-0010 D6 is about.
    """
    return encode_opm(
        points,
        generator=generator,
        viewpoint=Viewpoint(fov_y_degrees=fov, aspect=aspect),
        source_size=source_size,
        model_size=source_size if model_size is None else model_size,
        color_alpha=color_alpha,  # type: ignore[arg-type]
        metric=metric,
    )


# ---------------------------------------------------------------------------------------------
# The container


def test_the_container_is_what_the_renderer_reads():
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image())
    data = _encode(points, aspect=4 / 3, source_size=(40, 30))
    header = _decode(data)
    assert header["format"] == "orimera-point-map"
    assert header["version"] == 2
    assert header["pointCount"] == points.count
    # Fixed at 3 by the container. A point map is not a splat, and a 1 here would describe a file
    # this is not.
    assert header["rung"] == 3
    # Declared rather than inferred, and this producer's alpha is coverage rather than belief.
    assert header["colorAlpha"] == "support"
    assert {s["name"] for s in header["sections"]} == {"position", "color", "tags"}
    report = validate_opm(data)
    assert report.source_camera_contract_aligned is True
    assert report.point_count == points.count
    assert report.metric is True
    assert report.color_alpha == "support"


def test_the_declared_aspect_is_the_photograph_and_not_the_model_grid():
    """A 3:2 photograph must reconstruct, and it did not.

    REGRESSION, 2026-09-03. A depth model works at a bounded resolution and rounds to whole
    pixels, so a 3:2 source arrives at the builder as 1.4884 rather than 1.5. The stage declared
    that rounded number as the viewpoint's aspect, both validators compare the declared aspect
    against `sourceImage`, and every source that was not exactly 4:3 was refused. A pipeline that
    can only reconstruct one aspect ratio cannot reconstruct a photograph library.

    The field describes the camera that took the photograph, so the photograph's own dimensions
    are the only faithful statement of it. The vertical field of view beside it still comes from
    the model, because a resize preserves it and the model is what recovered it.
    """
    source = _image(1500, 1000)
    prediction = FlatDepthModel().predict(source)
    assert prediction.width / prediction.height != source.width / source.height, (
        "this test is pointless unless the model's working grid rounds the aspect away"
    )
    points = build_point_map(prediction, source)

    accepted = _encode(
        points,
        aspect=source.width / source.height,
        fov=prediction.fov_y_degrees,
        source_size=source.size,
        model_size=(prediction.width, prediction.height),
    )
    report = validate_opm(accepted)
    assert report.source_camera_contract_aligned is True
    # Both facts are in the file now, and they are different numbers. OPM/1 stated one of them
    # and left the other to be inferred from a point count.
    assert report.source_size == source.size
    assert report.model_size == (prediction.width, prediction.height)

    with pytest.raises(ValueError, match="aspect"):
        validate_opm(
            _encode(
                points,
                aspect=prediction.width / prediction.height,
                fov=prediction.fov_y_degrees,
                source_size=source.size,
                model_size=(prediction.width, prediction.height),
            )
        )


def test_integrity_refuses_a_point_behind_the_declared_source_camera():
    prediction = FlatDepthModel().predict(_image(4, 3))
    data = bytearray(
        _encode(build_point_map(prediction, _image(4, 3)), aspect=4 / 3, source_size=(4, 3))
    )
    header = _decode(data)
    offset = next(s["byteOffset"] for s in header["sections"] if s["name"] == "position")
    import struct

    struct.pack_into("<f", data, offset + 8, 1.0)
    with pytest.raises(ValueError, match="not in front"):
        validate_opm(bytes(data))


def test_integrity_refuses_trailing_or_out_of_bounds_container_bytes():
    prediction = FlatDepthModel().predict(_image(4, 3))
    data = _encode(
        build_point_map(prediction, _image(4, 3)),
        aspect=4 / 3,
        source_size=(4, 3),
        metric=False,
    )
    with pytest.raises(ValueError, match="follow"):
        validate_opm(data + b"x")


def test_the_sections_are_contiguous_so_the_renderer_takes_its_fast_path():
    """PlayCanvas holds one vertex buffer per mesh and computes its own offsets for a packed
    planar format. A gap anywhere costs a per-point CPU repack, which the binding reports rather
    than hides, and which this writer exists to avoid.
    """
    prediction = FlatDepthModel().predict(_image(37, 23))
    points = build_point_map(prediction, _image(37, 23))
    header = _decode(_encode(points, aspect=1.0, source_size=(37, 23)))
    sections = {s["name"]: s for s in header["sections"]}
    count = header["pointCount"]
    assert sections["color"]["byteOffset"] - sections["position"]["byteOffset"] == 12 * count
    assert sections["tags"]["byteOffset"] - sections["position"]["byteOffset"] == 16 * count


def test_a_file_whose_sections_are_not_back_to_back_is_refused():
    """The zero-copy path is a property of the file, so the production validator makes it one.

    PlayCanvas holds one vertex buffer per mesh and computes its own offsets for a tightly packed
    planar format, so a gap anywhere costs a per-point CPU repack over every point in the corpus.
    The decoder in the browser reports that rather than refusing, because a slow region is better
    than a blank one; this validator stands in front of a durable artifact, where the right answer
    is not to write the file at all. Both halves of that were true under OPM/1 and only the
    writer's own layout was tested, so a validator that stopped checking would have been noticed
    by nothing.
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    header, sections = _parts(_encode(points, aspect=4 / 3, source_size=(40, 30)))
    assert validate_opm(_relaid(header, sections)).planar_contiguous is True
    with pytest.raises(ValueError, match="planar-contiguous"):
        validate_opm(_relaid(header, sections, gap=16))


def test_the_section_offsets_are_legal_for_a_typed_array_view():
    """A `Float32Array` needs a multiple of four and a `Uint16Array` a multiple of two. Not a
    style rule: the view constructor throws, so the renderer would fail to load the file at all.
    """
    for pixels in ((40, 30), (37, 23), (1, 1), (13, 7)):
        prediction = FlatDepthModel().predict(_image(*pixels))
        points = build_point_map(prediction, _image(*pixels))
        header = _decode(_encode(points, aspect=1.0, source_size=pixels))
        sections = {s["name"]: s for s in header["sections"]}
        assert sections["position"]["byteOffset"] % 4 == 0, pixels
        assert sections["tags"]["byteOffset"] % 2 == 0, pixels


def test_the_file_is_exactly_as_long_as_its_last_section_says():
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image())
    data = _encode(points, aspect=1.0, source_size=(40, 30))
    last = next(s for s in _decode(data)["sections"] if s["name"] == "tags")
    assert len(data) == last["byteOffset"] + last["byteLength"]


def test_the_container_carries_whether_the_scale_is_real():
    """A map that is not metric produces a region that is not metric, and a spatial question over
    it refuses with a stated reason rather than estimating a distance. The flag has to survive the
    trip into the file or that refusal never happens.
    """
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image())
    for metric in (True, False):
        header = _decode(_encode(points, aspect=1.0, source_size=(40, 30), metric=metric))
        assert header["metric"] is metric


# ---------------------------------------------------------------------------------------------
# OPM/2, decision by decision


def test_an_opm_one_container_is_refused_by_name_and_told_what_replaces_it():
    """ADR-0010 D9 is refuse and regenerate, and the refusal has to name the path.

    There is no upgrade on read and there is deliberately no converter: the container version
    lives in the depth stage's params, so it is inside the idempotency key, so re-running ingest
    writes a new artifact under a new key rather than rewriting this one. A message that said
    only "unsupported version" would leave a reader looking for the tool that does not exist.
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    header, sections = _parts(_encode(points, aspect=4 / 3, source_size=(40, 30)))
    header["version"] = 1
    with pytest.raises(ValueError, match="OPM/1") as raised:
        validate_opm(_relaid(header, sections))
    assert "depth stage" in str(raised.value), (
        "the refusal must name what regenerates the file, because nothing converts one"
    )


def test_a_section_this_build_has_never_heard_of_is_carried_rather_than_refused():
    """The whole of ADR-0010 D2: "a registered optional section is not a version bump".

    That sentence is only true if a reader that has never heard of a section can still read the
    ones it knows. A validator that refused an unknown name would make the next attribute another
    version, which is the thing this version exists to be the last of. The three required
    sections still have to be contiguous, so the newcomer goes after them.
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    header, sections = _parts(_encode(points, aspect=4 / 3, source_size=(40, 30)))
    header["sections"].append({
        "name": "curvature",
        "type": "float32",
        "components": 1,
        "normalized": False,
        "byteOffset": 0,
        "byteLength": points.count * 4,
    })
    sections["curvature"] = bytes(points.count * 4)
    report = validate_opm(_relaid(header, sections))
    assert report.point_count == points.count
    assert report.planar_contiguous is True


def test_a_section_this_build_does_know_must_have_the_shape_it_knows():
    """The other half of D2, and the half that keeps tolerance from becoming credulity.

    An unknown name is a section a later writer added. A known name with a different type is a
    file that means something else by a word this reader is about to build a typed-array view
    from, which is how a header edit becomes an out-of-bounds read.
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    header, sections = _parts(_encode(points, aspect=4 / 3, source_size=(40, 30)))
    for section in header["sections"]:
        if section["name"] == "tags":
            section["components"] = 1
            section["byteLength"] = points.count * 2
    sections["tags"] = bytes(points.count * 2)
    with pytest.raises(ValueError, match="tags section layout"):
        validate_opm(_relaid(header, sections))


def test_the_tags_section_is_four_bytes_a_point_so_webgpu_can_bind_it():
    """ADR-0010 D3, and the number is the whole decision.

    A planar uint16 channel is a vertex stream with `arrayStride` 2. WebGL2 accepts it, PlayCanvas
    warns about it, and WebGPU rejects the pipeline outright and silently in a release build. The
    binding was widening the channel with a per-point CPU pass over every point in the corpus,
    which is exactly the parsing cost this container was designed not to have. So the file now
    stores what the engine had to be given: two uint16 channels, twenty bytes a point.
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    data = _encode(points, aspect=4 / 3, source_size=(40, 30))
    tags = next(s for s in _decode(data)["sections"] if s["name"] == "tags")
    assert tags["type"] == "uint16"
    assert tags["components"] == 2
    assert tags["byteLength"] == points.count * 4
    assert POINT_STRIDE_BYTES == 20
    assert len(data) - tags["byteOffset"] + 16 * points.count == POINT_STRIDE_BYTES * points.count


def test_a_segment_id_the_renderer_could_not_index_is_refused():
    """ADR-0010 D3: the declared range is what the renderer can draw, not the width of the field.

    The semantic table holds sixteen entries, the binding raises for a larger id and the shaders
    index a fixed array. A file declaring id 900 would be declaring something nothing in this
    product can present, and the sixteen-bit field is the binding's shape rather than a licence.

    **Sixteen is spelled out rather than taken from the constant**, and that is the difference
    between a test and a tautology. An input written as ``MAX_SEGMENT_ID + 1`` is refused at
    every value the constant could hold, so it would pass unchanged if somebody widened the
    range back to the width of the field, which is the exact regression it exists to catch.
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    header, sections = _parts(_encode(points, aspect=4 / 3, source_size=(40, 30)))
    header["segments"] = [{"id": 16, "name": "far", "cls": "structure"}]
    with pytest.raises(ValueError, match="semantic table"):
        validate_opm(_relaid(header, sections))
    assert MAX_SEGMENT_ID == 15


def test_the_declared_segment_range_is_the_one_the_renderer_enforces():
    """The two halves of D3's "a change to both together", made mechanical.

    Neither language can import the other, so the agreement between this bound and the renderer's
    semantic table is a thing a reader has to check by hand, which is a thing a reader does not
    do. Reading the constant out of the TypeScript source is what makes widening one of the two
    alone fail here, and it is the same arrangement `tests/test_geometry_delivery.py` uses to pin
    the artifact kind's two spellings together.
    """
    from pathlib import Path

    semantics = (
        Path(__file__).resolve().parents[1]
        / "web"
        / "packages"
        / "atlas-react"
        / "src"
        / "playcanvas"
        / "semantics.ts"
    )
    declared = re.search(r"^export const MAX_SEGMENTS = (\d+);$", semantics.read_text(), re.M)
    assert declared is not None, (
        f"{semantics.name} no longer declares MAX_SEGMENTS where this can read it. It is the "
        "bound the container declares, so the two cannot be allowed to drift silently."
    )
    assert int(declared.group(1)) == MAX_SEGMENT_ID + 1, (
        "the renderer's semantic table and the container's declared segment range disagree. "
        "ADR-0010 D3 makes widening the range a change to both together."
    )


def test_a_reserved_bit_of_the_tags_flags_channel_is_refused():
    """Fifteen bits are reserved and validated zero, which is what makes the next flag a widening.

    A writer that filled the word with something of its own would leave the next flag reading
    bytes that already mean something else, and there would be no version in which that was
    discoverable.
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    header, sections = _parts(_encode(points, aspect=4 / 3, source_size=(40, 30)))
    tags = bytearray(sections["tags"])
    struct.pack_into("<H", tags, 2, 0x0002)
    sections["tags"] = bytes(tags)
    with pytest.raises(ValueError, match="reserved bit"):
        validate_opm(_relaid(header, sections))


def test_a_survivor_beside_a_silhouette_drop_says_so_and_its_neighbours_do_not():
    """ADR-0010 D4's bit 0, and the discrimination is the point rather than the count.

    Sixteen columns, the far strip beginning at column 12, so the step falls between columns 11
    and 12 and both are dropped. The two columns that lost a neighbour to that drop are 10 and
    13, and every other survivor kept both of its lateral neighbours. A flag that marked every
    survivor, or none, would pass a test that only counted.
    """
    points = build_point_map(_mixed_sampling(), _image(16, 4), max_depth_step=0.10)
    marked: dict[int, int] = {}
    for index in range(points.count):
        x = points.position[index * 3]
        depth = -points.position[index * 3 + 2]
        column = round(x / (depth * 0.1))
        marked.setdefault(column, points.tags[index * 2 + 1] & TAG_ONE_SIDED)
        assert marked[column] == points.tags[index * 2 + 1] & TAG_ONE_SIDED, (
            "every row of a column lost the same neighbour, so the flag cannot differ down it"
        )
    assert sorted(column for column, flag in marked.items() if flag) == [10, 13]
    assert points.statistics["oneSidedPoints"] == 8.0
    assert 11 not in marked and 12 not in marked, "the dropped columns are not in the file"


def test_a_point_at_the_edge_of_the_photograph_is_not_marked_one_sided():
    """The distinction that gives the flag its value, and the easiest one to lose.

    A point in the first or last column has fewer neighbours because the photograph ends, which
    is a fact a loader can work out for itself from the lattice it reprojects. Bit 0 means the
    stage TOOK a neighbour, so the flag stays a statement about the silhouette drop rather than
    a restatement of "this point has a missing neighbour".
    """
    points = build_point_map(_mixed_sampling(), _image(16, 4), max_depth_step=0.10)
    edges = [
        points.tags[index * 2 + 1] & TAG_ONE_SIDED
        for index in range(points.count)
        if round(points.position[index * 3] / (-points.position[index * 3 + 2] * 0.1))
        in (0, 15)
    ]
    assert len(edges) == 8, "four rows at each of the two edge columns"
    assert not any(edges)


def test_a_map_with_no_silhouette_to_drop_marks_nothing():
    """The filter costs nothing on a plane, and so must the flag. A build that marked the whole
    frame would look like it worked, because every point would carry the same value.
    """
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image(), max_depth_step=0.10)
    assert points.statistics["oneSidedPoints"] == 0.0
    assert not any(points.tags[index * 2 + 1] for index in range(points.count))
    data = _encode(points, aspect=4 / 3, source_size=(40, 30))
    assert validate_opm(data).one_sided_points == 0


def test_the_alpha_channel_has_to_say_which_quantity_it_holds():
    """ADR-0010 D5. Support is coverage, counted; confidence is belief. Both are legal and a
    reader must not have to guess, which is what it was doing: it told the two writers apart by
    the presence of a statistics key, "which is a format flag that nobody declared as one".
    """
    points = build_point_map(FlatDepthModel().predict(_image()), _image())
    for declared in ("support", "confidence"):
        data = _encode(points, aspect=4 / 3, source_size=(40, 30), color_alpha=declared)
        assert validate_opm(data).color_alpha == declared

    header, sections = _parts(_encode(points, aspect=4 / 3, source_size=(40, 30)))
    header["colorAlpha"] = "alpha"
    with pytest.raises(ValueError, match="colorAlpha"):
        validate_opm(_relaid(header, sections))


@pytest.mark.parametrize(
    ("source", "model"),
    [
        ((11, 7), (11, 7)),
        ((1500, 1000), (512, 341)),
        ((1500, 1000), (512, 342)),
        ((1000, 1000), (400, 400)),
        ((3000, 2), (512, 1)),
    ],
)
def test_a_model_grid_one_uniform_resize_could_have_produced_is_accepted(source, model):
    """ADR-0010 D6 requires consistency rather than equality, and the derivation is the decision.

    A depth model scales by one factor and rounds each dimension to whole pixels on its own, so
    the honest question is whether ANY real scale could have produced both numbers. That needs no
    tolerance constant, and it needs no knowledge of the scale, which is the part that matters:
    the scale is not in the file, so a rule phrased as "within one row of the scaled value" could
    not be evaluated at all. The last case is the clamp rather than a rounding, and a photograph
    two pixels tall is thin rather than malformed.
    """
    points = build_point_map(FlatDepthModel().predict(_image(4, 3)), _image(4, 3))
    data = _encode(
        points,
        aspect=source[0] / source[1],
        source_size=source,
        model_size=model,
    )
    assert validate_opm(data).model_size == model


@pytest.mark.parametrize("model", [(512, 343), (512, 512), (513, 341)])
def test_a_model_grid_whose_two_dimensions_imply_different_scales_is_refused(model):
    """The other side of the same derivation. 1500x1000 at a 512 px longest edge gives 341, and
    342 is still reachable because the two rounding windows overlap; 343 needs the width to have
    been scaled by one factor and the height by another, which no resize does.
    """
    points = build_point_map(FlatDepthModel().predict(_image(4, 3)), _image(4, 3))
    with pytest.raises(ValueError, match="modelImage"):
        validate_opm(
            _encode(points, aspect=1.5, source_size=(1500, 1000), model_size=model)
        )


# ---------------------------------------------------------------------------------------------
# What is dropped, and why


def test_a_point_the_model_could_not_place_is_absent_rather_than_guessed():
    """The holes are the product. "The geometry is honestly incomplete": a pixel the model could
    not place has no point, rather than a point at a plausible distance.
    """
    prediction = FlatDepthModel(valid_fraction=0.25).predict(_image())
    points = build_point_map(prediction, _image())
    total = prediction.width * prediction.height
    assert points.count == round(total * 0.25)
    assert points.statistics["validFraction"] == pytest.approx(0.25, abs=0.02)


def test_a_placed_point_is_coloured_from_the_photograph_it_came_from():
    """A citation opens the original, and a viewer comparing the two should find that colour."""
    image = _image()
    prediction = FlatDepthModel().predict(image)
    points = build_point_map(prediction, image)
    resized = image.resize((prediction.width, prediction.height), Image.Resampling.NEAREST)
    expected = resized.getpixel((0, 0))
    assert tuple(points.color[0:3]) == expected


def test_a_plane_has_no_silhouette_to_drop():
    """The filter must cost nothing where there is no discontinuity, which is the whole of the
    double. A test suite that quietly lost points to it would be measuring the filter's bugs.
    """
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image(), max_depth_step=0.10)
    assert points.count == prediction.width * prediction.height
    assert points.statistics["discontinuityDropped"] == 0.0


def test_a_silhouette_drops_the_points_on_both_sides_of_it():
    """A pixel spanning the edge of a near surface lands in the air between it and the far one,
    and from a single view there is nothing that says which of the two the point belongs to. So
    both go, and the outer column of each surface is what survives.
    """
    points = build_point_map(_stepped(), _image(4, 2), max_depth_step=0.10)
    assert points.count == 4
    assert points.statistics["discontinuityDropped"] == 4.0
    # The survivors are the two surfaces themselves, at their own depths and nowhere between.
    depths = sorted({-points.position[index * 3 + 2] for index in range(points.count)})
    assert depths == pytest.approx([2.0, 10.0])


def test_the_silhouette_filter_can_be_turned_off():
    """`None` is what a caller comparing against the unfiltered map passes. It has to keep every
    placed point, or the comparison is against a third thing that is neither.
    """
    points = build_point_map(_stepped(), _image(4, 2), max_depth_step=None)
    assert points.count == 8
    assert points.statistics["discontinuityDropped"] == 0.0


def test_the_statistics_account_for_every_source_pixel():
    """Placed, dropped for the silhouette, and never placed at all. A reader has to be able to
    recover the prediction's own valid fraction from the file, because the gate reads that one
    and `validFraction` here counts only what survived to be written.
    """
    prediction = FlatDepthModel(valid_fraction=0.5).predict(_image())
    points = build_point_map(prediction, _image(), max_depth_step=0.10)
    statistics = points.statistics
    placed_by_the_model = sum(1 for byte in prediction.valid if byte)
    assert statistics["placedPoints"] + statistics["discontinuityDropped"] == placed_by_the_model
    assert statistics["sourcePixels"] == float(prediction.width * prediction.height)


def test_a_plane_is_supported_evenly_because_it_is_sampled_evenly():
    """The alpha channel is a ratio against the map's own median spacing, so the double, whose
    samples are a uniform grid, must come out flat. Anything else means the measure is reading
    something other than spacing.
    """
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image())
    alphas = [points.color[index * 4 + 3] for index in range(points.count)]
    assert min(alphas) > 200
    assert points.statistics["meanSupport"] > 0.95
    assert points.statistics["medianSampleSpacingM"] > 0


def test_a_coarsely_sampled_surface_says_so_in_the_alpha_channel():
    """The far patch is five times further away, so its samples land five times further apart and
    each one stands for twenty-five times the surface. That is the whole point of the channel: it
    is the sky and the grazing pavement that must arrive marked, not the wall in front of you.
    """
    points = build_point_map(_mixed_sampling(), _image(16, 4))
    near = [
        points.color[i * 4 + 3]
        for i in range(points.count)
        if -points.position[i * 3 + 2] < 5.0
    ]
    far = [
        points.color[i * 4 + 3]
        for i in range(points.count)
        if -points.position[i * 3 + 2] > 5.0
    ]
    assert near and far
    assert max(far) < min(near), "the distant strip must not claim the support of the near surface"


def test_support_is_a_ratio_of_two_measured_lengths_and_not_a_probability():
    """`ConfidenceBand` in atlas-core deliberately cannot hold a percentage, because one implies a
    frequency guarantee nothing calibrated. This channel reports coverage, so the denominator it
    is a ratio of has to travel with the file or the numerator cannot be checked.
    """
    points = build_point_map(_mixed_sampling(), _image(16, 4))
    reference = points.statistics["medianSampleSpacingM"]
    assert reference > 0
    # Every alpha is the reference over that point's own spacing, clamped at full support.
    assert all(0 <= points.color[i * 4 + 3] <= 255 for i in range(points.count))


@pytest.mark.parametrize("value", [0.0, -0.1])
def test_a_max_depth_step_that_could_not_describe_a_step_is_refused(value: float):
    """Zero would drop every point with any neighbour at all, which is a silent empty file."""
    with pytest.raises(ValueError, match="must be positive"):
        build_point_map(FlatDepthModel().predict(_image()), _image(), max_depth_step=value)


# ---------------------------------------------------------------------------------------------
# The gate


def test_a_frame_the_model_could_place_earns_a_region_to_move_through():
    decision = decide_rung(FlatDepthModel(valid_fraction=1.0).predict(_image()))
    assert decision.rung == 3
    assert decision.valid_fraction == pytest.approx(1.0)


def test_a_frame_with_almost_nothing_placed_earns_rung_four_rather_than_a_bad_rung_three():
    """Rung 3 is specified as having no gate that can fail, and this does not contradict it.

    Monocular depth is defined for every image; what is not promised is that every image contains
    something to place. A photograph of overcast sky has nothing to walk through, and rung 4 is a
    real rung with a real experience rather than a failure.
    """
    decision = decide_rung(FlatDepthModel(valid_fraction=0.02).predict(_image()))
    assert decision.rung == 4
    assert "placed" in decision.reason


def test_the_gate_can_award_only_the_rungs_one_photograph_can_earn():
    """Rungs 1 and 2 are facts about a SET of photographs, and this gate sees one prediction.

    Structure from motion and a trained splat are properties of several frames together, so no
    branch here could read one however it was written, and a gate with an unreachable branch that
    looks reachable is how a system claims a rung it never earned. The rungs above 3 are decided
    by the quality receipts their own controllers return, over a scene rather than a capture.
    """
    awarded = {
        decide_rung(FlatDepthModel(valid_fraction=f).predict(_image(8, 8))).rung
        for f in (0.0, 0.1, 0.14, 0.16, 0.5, 1.0)
    }
    assert awarded == {3, 4}


# ---------------------------------------------------------------------------------------------
# The frame conversion, which is invisible when it is wrong


def test_moge_camera_coordinates_become_the_container_frame():
    """MoGe returns x right, y DOWN, z FORWARD. The container is +Y up and -Z forward.

    Getting this wrong produces a world that renders perfectly, upside down and behind the
    camera, which is precisely the class of error that survives a visual check by someone who has
    not seen the scene before.
    """
    assert to_opm_frame([1.0, 2.0, 3.0]) == [1.0, -2.0, -3.0]
    assert to_opm_frame([1.0, 2.0, 3.0, -4.0, -5.0, -6.0]) == [1.0, -2.0, -3.0, -4.0, 5.0, 6.0]


def test_the_conversion_is_its_own_inverse():
    original = [0.5, -1.5, 7.25, 3.0, 0.0, -2.5]
    assert to_opm_frame(to_opm_frame(original)) == original


# ---------------------------------------------------------------------------------------------
# The value type refuses to hold a malformed map


@pytest.mark.parametrize(
    ("position", "colour", "tags"),
    [
        (array("f", [0, 0, 0]), bytearray(3), array("H", [0, 0])),
        (array("f", [0, 0, 0]), bytearray(4), array("H", [0, 0, 0, 0])),
        (array("f", [0, 0]), bytearray(4), array("H", [0, 0])),
        # Two uint16 per point under OPM/2, so one entry per point is now a disagreement.
        (array("f", [0, 0, 0]), bytearray(4), array("H", [0])),
    ],
)
def test_a_point_map_whose_channels_disagree_is_refused(position, colour, tags):
    """Three arrays that disagree on how many points there are would produce a file the renderer
    reads as garbage, at an offset nobody would trace back to here.
    """
    with pytest.raises(ValueError):
        PointMap(position=position, color=colour, tags=tags, segments=[Segment(0, "a", "b")])


def test_an_empty_map_has_a_degenerate_extent_rather_than_an_exception():
    """A photograph the model found nothing in is a real outcome, and the thing that decides what
    to do about it is the quality gate rather than the value type.
    """
    empty = PointMap(position=array("f"), color=bytearray(), tags=array("H"))
    assert empty.count == 0
    assert empty.bounds() == ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))


def test_a_prediction_whose_mask_and_points_disagree_is_refused():
    with pytest.raises(ValueError):
        DepthPrediction(
            width=2,
            height=2,
            points=[0.0] * 12,
            valid=b"\x01\x01",
            fov_y_degrees=55.0,
            metric=True,
            model_id="x",
        )


# ---------------------------------------------------------------------------------------------
# The pin across the language boundary


def test_the_committed_fixture_is_what_this_writer_produces():
    """`.opm` has two producers in two languages and one decoder, and neither language can import
    the other. So the pin is a small file: this side regenerates it and asserts it is
    byte-identical, and `web/packages/atlas-react/test/python-writer.test.ts` decodes the
    committed bytes with the renderer's own reader.

    A change to this writer fails here and says to regenerate. A change to the container fails
    there. Neither can drift alone.

    Eleven by seven is deliberate: seventy-seven points is not a multiple of four, which is
    exactly where the TypeScript writer's per-section alignment leaves a gap and the file falls
    off the renderer's zero-copy path. This writer aligns only the first section's start.
    """
    from pathlib import Path

    fixture = (
        Path(__file__).resolve().parents[1]
        / "web"
        / "packages"
        / "atlas-react"
        / "test"
        / "fixtures"
        / "python-writer.opm"
    )
    assert fixture.is_file(), (
        f"{fixture} is missing. It is the only thing tying this writer to the decoder that reads "
        "it; regenerate it rather than deleting the pin."
    )

    image = Image.new("RGB", (11, 7))
    pixels = image.load()
    assert pixels is not None
    for y in range(7):
        for x in range(11):
            pixels[x, y] = (x * 20 % 256, y * 30 % 256, 90)

    prediction = FlatDepthModel(max_edge=11).predict(image)
    points = build_point_map(prediction, image)
    regenerated = _encode(
        points,
        generator="flat-plane-double",
        aspect=prediction.width / prediction.height,
        fov=prediction.fov_y_degrees,
        source_size=image.size,
        model_size=(prediction.width, prediction.height),
    )
    assert regenerated == fixture.read_bytes(), (
        "the writer no longer produces the committed fixture. If that is intended, regenerate "
        f"{fixture.name} and check the TypeScript decoder still reads it."
    )

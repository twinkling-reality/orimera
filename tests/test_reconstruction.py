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
from array import array

import pytest
from orimera.reconstruction import (
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


def _decode(data: bytes) -> dict:
    assert data[0:4] == b"OPM1"
    length = int.from_bytes(data[4:8], "little")
    return json.loads(data[8 : 8 + length])


# ---------------------------------------------------------------------------------------------
# The container


def test_the_container_is_what_the_renderer_reads():
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image())
    data = encode_opm(
        points,
        generator="test",
        viewpoint=Viewpoint(fov_y_degrees=55.0, aspect=4 / 3),
        source_size=(40, 30),
        metric=True,
    )
    header = _decode(data)
    assert header["format"] == "orimera-point-map"
    assert header["version"] == 1
    assert header["pointCount"] == points.count
    # Fixed at 3 by the container. A point map is not a splat, and a 1 here would describe a file
    # this is not.
    assert header["rung"] == 3
    assert header["colorAlpha"] == "confidence"
    assert {s["name"] for s in header["sections"]} == {"position", "color", "segment"}
    report = validate_opm(data)
    assert report.source_camera_contract_aligned is True
    assert report.point_count == points.count
    assert report.metric is True


def test_integrity_refuses_a_point_behind_the_declared_source_camera():
    prediction = FlatDepthModel().predict(_image(4, 3))
    data = bytearray(
        encode_opm(
            build_point_map(prediction, _image(4, 3)),
            generator="test",
            viewpoint=Viewpoint(fov_y_degrees=55.0, aspect=4 / 3),
            source_size=(4, 3),
            metric=True,
        )
    )
    header = _decode(data)
    offset = next(s["byteOffset"] for s in header["sections"] if s["name"] == "position")
    import struct

    struct.pack_into("<f", data, offset + 8, 1.0)
    with pytest.raises(ValueError, match="not in front"):
        validate_opm(bytes(data))


def test_integrity_refuses_trailing_or_out_of_bounds_container_bytes():
    prediction = FlatDepthModel().predict(_image(4, 3))
    data = encode_opm(
        build_point_map(prediction, _image(4, 3)),
        generator="test",
        viewpoint=Viewpoint(fov_y_degrees=55.0, aspect=4 / 3),
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
    header = _decode(
        encode_opm(
            points,
            generator="test",
            viewpoint=Viewpoint(fov_y_degrees=55.0, aspect=1.0),
            source_size=(37, 23),
            metric=True,
        )
    )
    sections = {s["name"]: s for s in header["sections"]}
    count = header["pointCount"]
    assert sections["color"]["byteOffset"] - sections["position"]["byteOffset"] == 12 * count
    assert sections["segment"]["byteOffset"] - sections["position"]["byteOffset"] == 16 * count


def test_the_section_offsets_are_legal_for_a_typed_array_view():
    """A `Float32Array` needs a multiple of four and a `Uint16Array` a multiple of two. Not a
    style rule: the view constructor throws, so the renderer would fail to load the file at all.
    """
    for pixels in ((40, 30), (37, 23), (1, 1), (13, 7)):
        prediction = FlatDepthModel().predict(_image(*pixels))
        points = build_point_map(prediction, _image(*pixels))
        header = _decode(
            encode_opm(
                points,
                generator="test",
                viewpoint=Viewpoint(fov_y_degrees=55.0, aspect=1.0),
                source_size=pixels,
                metric=True,
            )
        )
        sections = {s["name"]: s for s in header["sections"]}
        assert sections["position"]["byteOffset"] % 4 == 0, pixels
        assert sections["segment"]["byteOffset"] % 2 == 0, pixels


def test_the_file_is_exactly_as_long_as_its_last_section_says():
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image())
    data = encode_opm(
        points,
        generator="test",
        viewpoint=Viewpoint(fov_y_degrees=55.0, aspect=1.0),
        source_size=(40, 30),
        metric=True,
    )
    last = next(s for s in _decode(data)["sections"] if s["name"] == "segment")
    assert len(data) == last["byteOffset"] + last["byteLength"]


def test_the_container_carries_whether_the_scale_is_real():
    """A map that is not metric produces a region that is not metric, and a spatial question over
    it refuses with a stated reason rather than estimating a distance. The flag has to survive the
    trip into the file or that refusal never happens.
    """
    prediction = FlatDepthModel().predict(_image())
    points = build_point_map(prediction, _image())
    for metric in (True, False):
        header = _decode(
            encode_opm(
                points,
                generator="test",
                viewpoint=Viewpoint(fov_y_degrees=55.0, aspect=1.0),
                source_size=(40, 30),
                metric=metric,
            )
        )
        assert header["metric"] is metric


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


def test_the_gate_can_award_only_the_rungs_whose_producers_exist():
    """Rungs 1 and 2 need structure from motion and a trained splat. Neither producer exists, and
    a gate with an unreachable branch that looks reachable is how a system claims a rung it never
    earned.
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
    ("position", "colour", "segment"),
    [
        (array("f", [0, 0, 0]), bytearray(3), array("H", [0])),
        (array("f", [0, 0, 0]), bytearray(4), array("H", [0, 0])),
        (array("f", [0, 0]), bytearray(4), array("H", [0])),
    ],
)
def test_a_point_map_whose_channels_disagree_is_refused(position, colour, segment):
    """Three arrays that disagree on how many points there are would produce a file the renderer
    reads as garbage, at an offset nobody would trace back to here.
    """
    with pytest.raises(ValueError):
        PointMap(position=position, color=colour, segment=segment, segments=[Segment(0, "a", "b")])


def test_an_empty_map_has_a_degenerate_extent_rather_than_an_exception():
    """A photograph the model found nothing in is a real outcome, and the thing that decides what
    to do about it is the quality gate rather than the value type.
    """
    empty = PointMap(position=array("f"), color=bytearray(), segment=array("H"))
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
    regenerated = encode_opm(
        points,
        generator="flat-plane-double",
        viewpoint=Viewpoint(prediction.fov_y_degrees, prediction.width / prediction.height),
        source_size=image.size,
        metric=True,
    )
    assert regenerated == fixture.read_bytes(), (
        "the writer no longer produces the committed fixture. If that is intended, regenerate "
        f"{fixture.name} and check the TypeScript decoder still reads it."
    )

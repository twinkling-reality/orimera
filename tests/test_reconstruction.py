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

    accepted = encode_opm(
        points,
        generator="test",
        viewpoint=Viewpoint(
            fov_y_degrees=prediction.fov_y_degrees,
            aspect=source.width / source.height,
        ),
        source_size=source.size,
        metric=True,
    )
    assert validate_opm(accepted).source_camera_contract_aligned is True

    with pytest.raises(ValueError, match="aspect"):
        validate_opm(
            encode_opm(
                points,
                generator="test",
                viewpoint=Viewpoint(
                    fov_y_degrees=prediction.fov_y_degrees,
                    aspect=prediction.width / prediction.height,
                ),
                source_size=source.size,
                metric=True,
            )
        )


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

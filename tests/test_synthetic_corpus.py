"""The synthetic corpus, and whether it exercises what it claims to.

A corpus is a test fixture the size of a product, and the failure mode it invites is exactly the
one this repository has already found twice: input tidy enough that a broken pipeline looks
correct against it. So these tests are not about the pictures. They are about whether the corpus
reaches the code paths the ingest pipeline actually has.

Four properties, each of which would be silently absent from a corpus nobody checked:

*   Frames are written in SENSOR space and the orientation tag uprights them. Get the inverse
    transform wrong and the corpus is one of correctly oriented photographs that ingest turns
    sideways, which is worse than no corpus because everything downstream still passes.
*   The recorded position survives the trip through EXIF degrees, minutes and seconds exactly.
*   All three clock branches occur: a GPS time, a local time with an offset, and a local time
    with no offset at all.
*   The corpus contains a mirrored orientation, a trip with no fix, one place visited twice, and
    a subject that appears in more than one place. Each is a code path; a corpus missing one
    would let that path stay unexercised while the totals still looked healthy.
"""

from __future__ import annotations

import io
from collections import Counter
from dataclasses import replace

import pytest
from exulanica.corpus.photograph import TO_SENSOR_TRANSPOSE, compose, encode_jpeg
from exulanica.corpus.plan import DEVICES, TRIPS, build_plan
from exulanica.corpus.render import dot, sub
from exulanica.corpus.world import PLACES, SUBJECT_BUILDERS, box, prism
from exulanica.ingest.exif import UNKNOWN_OFFSET_UNCERTAINTY_MS, extract_exif_facts
from PIL import Image

ALL_ORIENTATIONS = list(range(1, 9))


def _open(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        return image.copy()


def _frames(frames_per_trip=4):
    return build_plan(seed=7, frames_per_trip=frames_per_trip)


# --------------------------------------------------------------------------------------------
# Sensor space


@pytest.mark.parametrize("orientation", ALL_ORIENTATIONS)
def test_the_written_file_uprights_to_the_picture_that_was_drawn(orientation):
    """The whole point of writing sensor pixels, checked for all eight values rather than some.

    `extract_exif_facts` applies the forward transform. If `TO_SENSOR_TRANSPOSE` holds anything
    but the exact inverse, the recovered image differs from the one drawn. Two of the eight
    values are pure mirrors and two more combine a mirror with a quarter turn, which is where
    composing in the wrong order goes wrong and where a rotation-only inverse looks fine.
    """
    frame = replace(_frames()[0], exif_orientation=orientation)
    display = compose(frame)

    recovered, facts = extract_exif_facts(_open(encode_jpeg(frame, display)))

    assert facts.orientation.exif_value == orientation
    assert recovered.size == display.size
    # JPEG is lossy, so the comparison is on structure rather than on exact bytes: a wrong
    # inverse moves the whole picture, which no quantisation table can account for.
    assert _mean_absolute_difference(recovered, display) < 6.0


def test_a_wrong_inverse_would_be_caught(monkeypatch):
    """The guard on the guard.

    A test that passes tells you nothing until you have seen it fail for the right reason. This
    swaps the two quarter turns, which is the single most likely way to get the table wrong, and
    asserts the test above would reject it.
    """
    frame = replace(_frames()[0], exif_orientation=6)
    display = compose(frame)

    monkeypatch.setitem(TO_SENSOR_TRANSPOSE, 6, Image.Transpose.ROTATE_270)
    recovered, _facts = extract_exif_facts(_open(encode_jpeg(frame, display)))

    assert _mean_absolute_difference(recovered, display) > 6.0


def _mean_absolute_difference(a: Image.Image, b: Image.Image) -> float:
    if a.size != b.size:
        return 255.0
    left, right = a.convert("RGB").tobytes(), b.convert("RGB").tobytes()
    return sum(abs(x - y) for x, y in zip(left, right, strict=True)) / len(left)


# --------------------------------------------------------------------------------------------
# What the file says about itself


def test_the_recorded_position_survives_degrees_minutes_and_seconds_exactly():
    """Ten-millionths of a degree in, the same integers out.

    EXIF stores a position as three rationals and a hemisphere letter, and a generator that
    rounded on the way in would make every clustering radius in the corpus slightly untrue while
    still producing plausible numbers.
    """
    positioned = [frame for frame in _frames() if frame.gps_e7 is not None]
    assert positioned, "the corpus must contain frames with a fix"

    for frame in positioned[:6]:
        _image, facts = extract_exif_facts(_open(encode_jpeg(frame, compose(frame))))
        assert facts.gps is not None
        assert (facts.gps.lat_e7, facts.gps.lon_e7) == frame.gps_e7
        assert facts.gps.altitude_mm == frame.altitude_mm


def test_every_frame_says_in_its_own_bytes_that_it_is_synthetic():
    """The disclosure lives in the file, not in the directory it happens to sit in."""
    frame = _frames()[0]
    _image, facts = extract_exif_facts(_open(encode_jpeg(frame, compose(frame))))

    assert facts.camera_make == "Exulanica"
    assert facts.camera_model is not None and facts.camera_model.startswith("Synthetic Camera")
    assert facts.software == "exulanica-corpus 1"
    assert "Synthetic" in str(facts.raw_tags["ifd0"]["270"])


# --------------------------------------------------------------------------------------------
# The three clock branches


def test_a_device_that_writes_gps_time_gives_a_gps_anchor():
    frame = next(
        f for f in _frames() if f.gps_e7 is not None and DEVICES[f.device_key].writes_offset
    )
    _image, facts = extract_exif_facts(_open(encode_jpeg(frame, compose(frame))))

    assert facts.clock is not None
    assert facts.clock.source == "gps"
    assert facts.clock.assumed_utc is False
    assert facts.clock.utc == frame.utc_instant


def test_a_device_that_writes_an_offset_but_no_fix_recovers_the_true_instant():
    """The indoor trip: no GPS, so the offset tag is the only thing that places the instant."""
    frame = next(
        f for f in _frames() if f.gps_e7 is None and DEVICES[f.device_key].writes_offset
    )
    _image, facts = extract_exif_facts(_open(encode_jpeg(frame, compose(frame))))

    assert facts.clock is not None
    assert facts.clock.source == "container_creation_time"
    assert facts.clock.assumed_utc is False
    assert facts.clock.utc == frame.utc_instant


def test_a_device_that_writes_no_offset_leaves_the_instant_uncertain_by_the_whole_span():
    """The case a tidy corpus never reaches, and the common one in a real library.

    The pipeline is correct to read the timestamp as UTC and to carry 26 hours of uncertainty,
    and it is correct that the instant it stores is NOT the true instant. Asserting the
    inequality is the point: a corpus where every file happened to be UTC would let a pipeline
    that ignored the offset entirely look exactly as good.
    """
    frame = next(f for f in _frames() if not DEVICES[f.device_key].writes_offset)
    _image, facts = extract_exif_facts(_open(encode_jpeg(frame, compose(frame))))

    assert facts.clock is not None
    assert facts.clock.assumed_utc is True
    assert facts.clock.uncertainty_ms == UNKNOWN_OFFSET_UNCERTAINTY_MS
    assert facts.clock.utc != frame.utc_instant


# --------------------------------------------------------------------------------------------
# Does the corpus contain the cases it claims


def test_the_corpus_contains_a_mirrored_orientation():
    """Four of the eight values include a flip and `media_track.rotation` cannot express one."""
    orientations = {frame.exif_orientation for frame in _frames(16)}
    assert orientations & {2, 4, 5, 7}, f"no mirrored orientation in {sorted(orientations)}"


def test_one_place_is_visited_twice_and_one_trip_has_no_fix():
    places = Counter(trip.place_key for trip in TRIPS)
    assert [key for key, count in places.items() if count >= 2], "no place is visited twice"
    assert [trip for trip in TRIPS if trip.gps_centroid_e7 is None], "every trip has a fix"


def test_every_subject_appears_in_more_than_one_place():
    """Cross-capture continuity needs something that actually crosses captures."""
    places_by_subject: dict[str, set[str]] = {}
    for trip in TRIPS:
        for subject in trip.subjects:
            places_by_subject.setdefault(subject, set()).add(trip.place_key)
    assert places_by_subject, "the corpus carries no subjects"
    for subject, places in places_by_subject.items():
        assert len(places) >= 2, f"{subject} only ever appears in {places}"


def test_the_same_seed_produces_the_same_bytes():
    """Ingesting twice must be a genuine no-op, which it is not if the pixels move."""
    first = build_plan(seed=7, frames_per_trip=3)[0]
    second = build_plan(seed=7, frames_per_trip=3)[0]
    assert encode_jpeg(first, compose(first)) == encode_jpeg(second, compose(second))


def test_a_different_seed_produces_a_different_corpus():
    first = build_plan(seed=7, frames_per_trip=3)[0]
    other = build_plan(seed=8, frames_per_trip=3)[0]
    assert encode_jpeg(first, compose(first)) != encode_jpeg(other, compose(other))


# --------------------------------------------------------------------------------------------
# The geometry the renderer relies on


def test_every_face_of_every_solid_faces_outward():
    """Backface culling reads the winding, so an inward face is an invisible one.

    A solid built with one face wound backwards shows the inside of itself through the outside,
    which reads as a lighting bug rather than as a geometry bug and is why this is a test rather
    than a review comment.
    """
    centre = (0.0, 0.0, 0.0)
    solids = [
        box(centre, (2.0, 3.0, 4.0), (10, 20, 30)),
        box(centre, (1.0, 1.0, 1.0), (10, 20, 30), yaw_degrees=37.0),
        prism(centre, 1.0, 2.0, 3, (10, 20, 30)),
        prism(centre, 1.0, 2.0, 12, (10, 20, 30), yaw_degrees=11.0),
    ]
    for solid in solids:
        for face in solid:
            midpoint = tuple(
                sum(vertex[axis] for vertex in face.vertices) / len(face.vertices)
                for axis in range(3)
            )
            assert dot(face.normal(), sub(midpoint, centre)) > 0.0


def test_a_subject_rests_on_the_surface_it_is_given_rather_than_through_it():
    """The resting-point convention, checked rather than trusted.

    Every builder takes the point the object stands on. If one of them treated that point as its
    own centre instead, the object would be sunk into the surface by half its height, and in a
    corpus meant to be reconstructable that is a real geometric error rather than a cosmetic one.
    """
    support = 1.75
    for key, builder in SUBJECT_BUILDERS.items():
        faces = builder((0.0, 0.0, support), 0.0)
        lowest = min(vertex[2] for face in faces for vertex in face.vertices)
        highest = max(vertex[2] for face in faces for vertex in face.vertices)
        assert lowest == pytest.approx(support, abs=1e-9), f"{key} does not rest on its surface"
        assert highest > support, f"{key} has no height"


def test_the_camera_never_stands_inside_a_wall_of_the_interior():
    """The one place the camera is enclosed by, so the one place it can be standing in a wall.

    An orbit radius that exceeded the room would put the eye behind a wall, and the frame it
    produced would be a picture of the outside of a room the corpus says it is inside.
    """
    kitchen = PLACES["kitchen"]
    inside = [f for f in _frames(16) if f.place_key == "kitchen"]
    assert inside, "the corpus has no interior frames"
    for frame in inside:
        for axis in (0, 1):
            assert abs(frame.camera.eye[axis] - kitchen.orbit_centre[axis]) < 4.2

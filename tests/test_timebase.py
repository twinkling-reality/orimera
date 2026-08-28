"""The canonical timebase, the rational anchor, and the degenerate photograph interval."""

from __future__ import annotations

import pytest
from orimera.errors import InvalidAddressError
from orimera.evidence import (
    IMAGE_TIME_BASE,
    NS_PER_SECOND,
    PHOTOGRAPH_INTERVAL,
    TimeBase,
    TimeInterval,
    ns_to_seconds,
    seconds_to_ns,
)


def test_photograph_interval_is_the_smallest_non_empty_half_open_interval():
    assert TimeInterval(0, 1) == PHOTOGRAPH_INTERVAL
    assert PHOTOGRAPH_INTERVAL.duration_ns == 1


def test_an_empty_interval_is_refused():
    """[0, 0) contains nothing and overlaps nothing.

    If images were allowed an empty interval, the tombstone interval guard would test overlap
    against it, find none, and silently fail open. That is the specific bug this refusal
    prevents, so it is asserted rather than assumed.
    """
    with pytest.raises(InvalidAddressError):
        TimeInterval(0, 0)
    with pytest.raises(InvalidAddressError):
        TimeInterval(500, 100)


def test_two_photographs_overlap_the_way_two_video_moments_do():
    """Co-presence in one photograph must be the same query as co-presence in one video moment."""
    face_a = PHOTOGRAPH_INTERVAL
    face_b = PHOTOGRAPH_INTERVAL
    assert face_a.overlaps(face_b)
    assert TimeInterval(0, 4_000_000_000).overlaps(TimeInterval(3_000_000_000, 9_000_000_000))
    assert not TimeInterval(0, 1).overlaps(TimeInterval(1, 2))  # half-open, so they abut


def test_image_timebase_is_the_canonical_axis():
    assert TimeBase(1, NS_PER_SECOND) == IMAGE_TIME_BASE
    assert IMAGE_TIME_BASE.ticks_from_ns(0) == 0
    assert IMAGE_TIME_BASE.ticks_from_ns(1) == 1
    assert IMAGE_TIME_BASE.ns_from_ticks(1) == 1


def test_the_frozen_conversion_formulas_produce_exactly_the_documented_values():
    """Pins both directions of the frozen contract at 48 kHz and at 1/15360 video ticks.

    A 1/48000 s tick is 20833.333... ns, which nanoseconds cannot hold exactly. That is the
    whole reason the rational anchor is stored rather than discarded once t_ns is computed.
    """
    audio = TimeBase(1, 48_000)
    assert audio.ns_from_ticks(0) == 0
    assert audio.ns_from_ticks(1) == 20_833  # round_half_down of 20833.333...
    assert audio.ns_from_ticks(3) == 62_500  # exact
    assert audio.ns_from_ticks(48_000) == NS_PER_SECOND
    assert audio.ticks_from_ns(NS_PER_SECOND) == 48_000
    assert audio.ticks_from_ns(20_832) == 0  # floor: still inside tick 0
    assert audio.ticks_from_ns(20_834) == 1

    video = TimeBase(1, 15_360)
    assert video.ns_from_ticks(15_360) == NS_PER_SECOND
    assert video.ticks_from_ns(NS_PER_SECOND) == 15_360


def test_tick_round_trip_is_lossy_under_the_frozen_rounding_rule():
    """DEFECT IN THE COMMITTED CONTRACT, pinned here so it cannot be changed quietly.

    tick -> ns -> tick is not the identity. ns_from_ticks rounds to nearest while ticks_from_ns
    floors, so any tick whose nanosecond value rounds *down* lands back on the previous tick:

        audio tick 1 -> 20833 ns -> tick 0

    The nanosecond axis is far finer than a 48 kHz tick (20833 nanoseconds per tick), so this
    is purely a mismatch of rounding directions, not a precision limit. A citation stored in
    nanoseconds and converted back to a tick for a seek would open one sample early.

    Correcting it means either rounding ns_from_ticks up, or rounding ticks_from_ns to nearest.
    Either is a change to a frozen formula and therefore a span_format_version event, which is
    why this test asserts the broken behaviour rather than the desired one: a silent fix would
    change every span digest already issued, and this test is what stops that happening by
    accident.

    Dormant for the photograph corpus, where the timebase is the canonical axis itself and the
    round trip is exact. It becomes live the day video arrives.
    """
    audio = TimeBase(1, 48_000)
    lost = [t for t in range(1, 200) if audio.ticks_from_ns(audio.ns_from_ticks(t)) != t]
    assert lost, "the frozen rule still loses ticks; if this passes empty, the rule changed"
    assert lost[0] == 1

    # The photograph case is exact, which is why the defect is not blocking at MVP.
    for ticks in (0, 1, 2, 1_000_000):
        assert IMAGE_TIME_BASE.ticks_from_ns(IMAGE_TIME_BASE.ns_from_ticks(ticks)) == ticks


def test_tick_conversion_floors_toward_negative_infinity_for_negative_times():
    """Negative t_ns is real: it happens whenever start_pts is later than track zero."""
    base = TimeBase(1, 48_000)
    assert base.ticks_from_ns(-1) == -1  # floor, not truncation toward zero
    assert base.ticks_from_ns(-20_834) == -2


def test_a_non_positive_timebase_is_refused():
    with pytest.raises(InvalidAddressError):
        TimeBase(0, 1000)
    with pytest.raises(InvalidAddressError):
        TimeBase(1, -1000)


@pytest.mark.parametrize(
    "t_ns",
    [0, 1, 999_999_999, 1_000_000_000, 12_500_000_000, -1, -12_500_000_001, 2**62],
)
def test_seconds_rendering_is_lossless(t_ns):
    assert seconds_to_ns(ns_to_seconds(t_ns)) == t_ns


def test_seconds_rendering_matches_the_documented_permalink_form():
    assert ns_to_seconds(12_500_000_000) == "12.5"
    assert ns_to_seconds(18_250_000_000) == "18.25"
    assert ns_to_seconds(0) == "0"
    assert ns_to_seconds(1) == "0.000000001"


def test_sub_nanosecond_seconds_are_refused_rather_than_rounded():
    """Silently rounding would move a citation boundary and change its digest."""
    with pytest.raises(InvalidAddressError):
        seconds_to_ns("1.0000000005")

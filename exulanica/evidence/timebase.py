"""The canonical timebase: signed int64 nanoseconds plus a stored rational anchor.

Two axes, deliberately kept apart:

*   ``t_ns`` is the canonical axis. Signed int64 nanoseconds since track zero. Every span,
    query and UI element uses it, because it is comparable across track kinds and indexes as a
    plain ``int8range``.
*   ``TimeBase`` is the exact anchor, the ``time_base_num`` / ``time_base_den`` rational
    observed at ingest, stored verbatim on the track row. Nanoseconds cannot exactly represent
    a 1/48000 s audio tick (20833.333... ns), which is why the rational is kept rather than
    discarded once ``t_ns`` is computed.

The two conversion formulas are frozen contract. They may not change without a
``span_format_version`` bump, because ``t_start_ns`` and ``t_end_ns`` are inputs to the span
digest and therefore to every citation token and permalink already issued.

    ticks(t_ns) = floor( (t_ns * den) / (num * 1_000_000_000) )
    t_ns(ticks) = round_half_down( ticks * num * 1_000_000_000 / den )

**Under-specified in the committed contract, and settled here:** the contract names
``round_half_down`` but never defines it, and the two plausible readings (ties toward zero
versus ties toward negative infinity) differ for negative exact halves. Negative ``t_ns``
occurs whenever a container's ``start_pts`` is later than track zero, which edit lists produce
routinely, so the case is real rather than theoretical. This implementation takes the standard
meaning of the name, the one used by ``decimal.ROUND_HALF_DOWN`` and Java's
``RoundingMode.HALF_DOWN``: ties resolve toward zero. This is flagged for confirmation before
v1 is frozen.

A photograph is the degenerate case and is not special-cased anywhere: it is a single-sample
track whose timebase is the canonical axis itself (1/1_000_000_000), whose ``start_pts`` is 0,
and whose interval is ``[0, 1)`` nanoseconds, the smallest non-empty half-open interval. The
interval is a structural placeholder and carries no semantics about the photograph. It exists
so that the interval-overlap paths, the tombstone interval guard, and the digest tuple shape
are exercised by the photograph corpus rather than left untested until video arrives.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from exulanica.canonical import round_half_down
from exulanica.errors import InvalidAddressError

__all__ = [
    "IMAGE_TIME_BASE",
    "NS_PER_SECOND",
    "PHOTOGRAPH_INTERVAL",
    "TimeBase",
    "TimeInterval",
    "ns_to_seconds",
    "seconds_to_ns",
]

NS_PER_SECOND: Final = 1_000_000_000

_INT64_MIN: Final = -(2**63)
_INT64_MAX: Final = 2**63 - 1


def _check_int64(value: int, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvalidAddressError(f"{label} must be an int, got {type(value).__name__}")
    if not _INT64_MIN <= value <= _INT64_MAX:
        raise InvalidAddressError(f"{label} does not fit in int64: {value}")
    return value


@dataclass(frozen=True, slots=True)
class TimeBase:
    """A track's exact rational timebase, stored as observed rather than normalised.

    ``Fraction`` is deliberately not used: it reduces 2/30 to 1/15, and the point of this type
    is to round-trip what the container actually declared, so that a re-probe of the same bytes
    can be compared against what was stored.
    """

    num: int
    den: int

    def __post_init__(self) -> None:
        if not isinstance(self.num, int) or not isinstance(self.den, int):
            raise InvalidAddressError("time base components must be ints")
        if self.num <= 0 or self.den <= 0:
            raise InvalidAddressError(f"time base must be positive, got {self.num}/{self.den}")

    def ticks_from_ns(self, t_ns: int) -> int:
        """Frozen contract: floor((t_ns * den) / (num * 1e9))."""
        _check_int64(t_ns, "t_ns")
        return (t_ns * self.den) // (self.num * NS_PER_SECOND)

    def ns_from_ticks(self, ticks: int) -> int:
        """Frozen contract: round_half_down(ticks * num * 1e9 / den)."""
        if not isinstance(ticks, int) or isinstance(ticks, bool):
            raise InvalidAddressError("ticks must be an int")
        return round_half_down(ticks * self.num * NS_PER_SECOND, self.den)

    def __str__(self) -> str:
        return f"{self.num}/{self.den}"


#: The timebase of a still photograph: the canonical axis is its own timebase.
IMAGE_TIME_BASE: Final = TimeBase(1, NS_PER_SECOND)


@dataclass(frozen=True, slots=True, order=True)
class TimeInterval:
    """A half-open interval ``[start_ns, end_ns)`` on the canonical nanosecond axis.

    Half-open matches Media Fragments URI 1.0: the begin time is part of the interval and the
    end time is the first point that is not. Empty intervals are refused at construction,
    because an empty range is contained by nothing and overlaps nothing, so it would make the
    tombstone interval guard silently fail open.

    Ordering is by ``(start_ns, end_ns)``, which gives a citation list one deterministic
    playback order.
    """

    start_ns: int
    end_ns: int

    def __post_init__(self) -> None:
        _check_int64(self.start_ns, "start_ns")
        _check_int64(self.end_ns, "end_ns")
        if self.end_ns <= self.start_ns:
            raise InvalidAddressError(
                f"interval must be non-empty and half-open: [{self.start_ns}, {self.end_ns}) "
                "has end <= start. A photograph uses [0, 1), never [0, 0)."
            )

    @property
    def duration_ns(self) -> int:
        return self.end_ns - self.start_ns

    def contains(self, t_ns: int) -> bool:
        return self.start_ns <= t_ns < self.end_ns

    def overlaps(self, other: TimeInterval) -> bool:
        """True when the two half-open intervals share at least one nanosecond."""
        return self.start_ns < other.end_ns and other.start_ns < self.end_ns

    @classmethod
    def from_seconds(cls, start: str, end: str) -> TimeInterval:
        """Parse two decimal-second strings exactly, without going through float."""
        return cls(seconds_to_ns(start), seconds_to_ns(end))

    def __str__(self) -> str:
        return f"[{self.start_ns}, {self.end_ns})"


#: The degenerate interval every still photograph carries.
PHOTOGRAPH_INTERVAL: Final = TimeInterval(0, 1)


def seconds_to_ns(text: str) -> int:
    """Parse a decimal-seconds string to exact integer nanoseconds.

    Deliberately not ``float(text) * 1e9``: binary floating point cannot represent most
    decimal fractions, so a round trip through float would move citation boundaries by a
    nanosecond or two and change the span digest.
    """
    candidate = text.strip()
    if not candidate:
        raise InvalidAddressError("empty seconds value")
    negative = candidate.startswith("-")
    if negative or candidate.startswith("+"):
        candidate = candidate[1:]
    whole, _, frac = candidate.partition(".")
    if not whole.isdigit() or (frac and not frac.isdigit()):
        raise InvalidAddressError(f"not a decimal seconds value: {text!r}")
    if len(frac) > 9:
        raise InvalidAddressError(
            f"seconds value {text!r} has sub-nanosecond precision, which the canonical axis "
            "cannot represent"
        )
    value = int(whole) * NS_PER_SECOND + int(frac.ljust(9, "0") or "0")
    return -value if negative else value


def ns_to_seconds(t_ns: int) -> str:
    """Render exact integer nanoseconds as a decimal-seconds string.

    Trailing zeros in the fraction are trimmed and the point is dropped for whole seconds, so
    ``12500000000`` renders as ``12.5`` and ``0`` as ``0``. The rendering is injective over
    int64 nanoseconds, so ``seconds_to_ns(ns_to_seconds(x)) == x`` for every representable x.
    """
    _check_int64(t_ns, "t_ns")
    sign = "-" if t_ns < 0 else ""
    magnitude = abs(t_ns)
    whole, frac = divmod(magnitude, NS_PER_SECOND)
    if frac == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{frac:09d}".rstrip("0")

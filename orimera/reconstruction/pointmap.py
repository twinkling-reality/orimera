"""A point map: what one photograph turns out to have been looking at.

**This module knows nothing about evidence and must not learn.** It does not import
``orimera.evidence``, ``orimera.store`` or ``orimera.db``, and an import-linter contract enforces
that. Invariant 2 says reconstruction is never evidence, and the strongest available form of that
rule is a producer that cannot name a citation: a module with no way to construct an address
cannot return one, however it is later refactored by somebody who never read this comment.

**Stdlib arrays rather than numpy.** This package's only third-party dependency is Pillow, which
the project already carries for decode and EXIF. A quarter of a million points is 4.5 MB and
``array`` writes it with one ``tobytes`` call, so numpy would buy nothing here and would put a
build dependency in the path of a stage that has to run on a laptop. The depth model that fills
these arrays may well use numpy; that is its business and it is behind an interface.

**Confidence lives in the alpha channel, and the file says so.** The container documents
``colorAlpha: 'confidence'`` rather than leaving a reader to infer that a point's alpha is not
opacity. A renderer that treated it as opacity would fade uncertain geometry out, which is nearly
the right thing and would be a coincidence rather than a decision.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass, field
from typing import Final

__all__ = ["POINT_STRIDE_BYTES", "PointMap", "Segment"]

#: Bytes per point on the wire: position 12, colour 4, segment 2.
POINT_STRIDE_BYTES: Final = 18

#: Segment 0 is what a producer that does not segment anything writes. It is named `unsegmented`
#: rather than `unknown`, because nothing looked and failed: nothing looked.
UNSEGMENTED: Final = 0


@dataclass(frozen=True, slots=True)
class Segment:
    """A semantic region of the point map, if the producer has one. Often just the default."""

    id: int
    name: str
    cls: str


@dataclass(slots=True)
class PointMap:
    """Points in the capture's own local frame, metres, +Y up, -Z forward.

    The frame is the CAPTURE's, not the Atlas's. A point map has a real metric scale and a real
    origin at the camera; where that sits in the Atlas is a presentation decision made elsewhere
    and carried by the island's placement. Conflating the two is risk R-48 and the reason
    `atlas-core` does not export a distance function over atlas positions.
    """

    #: 3 floats per point.
    position: array
    #: 4 bytes per point, rgba, where a is confidence.
    color: bytearray
    #: 1 uint16 per point.
    segment: array
    segments: list[Segment] = field(default_factory=list)
    #: What the producer measured about itself. Never a plausible number.
    statistics: dict[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.position.typecode != "f":
            raise ValueError("position must be an array('f')")
        if self.segment.typecode != "H":
            raise ValueError("segment must be an array('H')")
        count = len(self.position) // 3
        if len(self.position) != count * 3:
            raise ValueError("position is not a whole number of points")
        if len(self.color) != count * 4:
            raise ValueError(f"colour has {len(self.color)} bytes for {count} points")
        if len(self.segment) != count:
            raise ValueError(f"segment has {len(self.segment)} entries for {count} points")

    @property
    def count(self) -> int:
        return len(self.position) // 3

    def bounds(self) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        """The axis-aligned extent, or a degenerate box at the origin for an empty map.

        A degenerate box rather than an exception: an empty point map is a real outcome for a
        photograph the model found nothing measurable in, and the caller that has to decide what
        to do about that is the quality gate, not this.
        """
        if self.count == 0:
            return ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
        lo = [float("inf")] * 3
        hi = [float("-inf")] * 3
        for index in range(0, len(self.position), 3):
            for axis in range(3):
                value = self.position[index + axis]
                if value < lo[axis]:
                    lo[axis] = value
                if value > hi[axis]:
                    hi[axis] = value
        return ((lo[0], lo[1], lo[2]), (hi[0], hi[1], hi[2]))

    def packed_bytes(self) -> bytes:
        """The three sections back to back, in the order a renderer reads them.

        Position, then colour, then segment, with no padding between them. That contiguity is
        what lets the PlayCanvas binding hand the engine a zero-copy view of the file: it holds
        one vertex buffer per mesh and computes its own offsets for a tightly packed planar
        format, so a gap anywhere in here costs a per-point CPU repack that the binding correctly
        reports rather than hides.
        """
        return self.position.tobytes() + bytes(self.color) + self.segment.tobytes()

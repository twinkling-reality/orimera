"""A point map: what one photograph turns out to have been looking at.

**This module knows nothing about evidence and must not learn.** It does not import
``exulanica.evidence``, ``exulanica.store`` or ``exulanica.db``, and an
import-linter contract enforces that. Invariant 2 says reconstruction is never
evidence, and the strongest available form of that
rule is a producer that cannot name a citation: a module with no way to construct an address
cannot return one, however it is later refactored by somebody who never read this comment.

**Stdlib arrays rather than numpy.** This package's only third-party dependency is Pillow, which
the project already carries for decode and EXIF. A quarter of a million points is 4.5 MB and
``array`` writes it with one ``tobytes`` call, so numpy would buy nothing here and would put a
build dependency in the path of a stage that has to run on a laptop. The depth model that fills
these arrays may well use numpy; that is its business and it is behind an interface.

**What the alpha channel means is declared, not inferred.** The container carries
``colorAlpha`` as an enum, ``support`` or ``confidence``, and this producer writes ``support``:
what :mod:`exulanica.reconstruction.build` puts there is a spacing ratio, which is coverage rather
than belief. ADR-0010 D5 made the field an enum for exactly this reason. Both writers used to
declare ``confidence`` and one of them had stopped meaning it, and the renderer told them apart
by the presence of a statistics key, "which is a format flag that nobody declared as one".

**Two uint16 channels per point, not one.** ADR-0010 D3: the segment attribute was two bytes,
WebGPU requires a vertex stream whose element size is a multiple of four, and the binding was
paying a per-point CPU pass to widen it. The container now stores what the engine already padded
to. Channel 0 is the segment id, unchanged in meaning; channel 1 is a flags word whose bit 0
says this point lost a neighbour to the silhouette drop, and whose remaining bits are reserved
and validated zero.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass, field
from typing import Final

__all__ = [
    "MAX_SEGMENT_ID",
    "POINT_STRIDE_BYTES",
    "RESERVED_TAG_FLAGS",
    "TAG_ONE_SIDED",
    "PointMap",
    "Segment",
]

#: Bytes per point on the wire: position 12, colour 4, tags 4. Eighteen under OPM/1, and the two
#: extra bytes are the alignment the WebGPU binding was already paying a per-point CPU pass for.
POINT_STRIDE_BYTES: Final = 20

#: Bit 0 of the tags flags channel: a four-neighbour of this point was dropped by the silhouette
#: test, so the sample it would have formed a tangent frame against is not in the file.
#:
#: The renderer can already see that a grid cell beside this one is empty. What it cannot see is
#: WHY, and the two answers want opposite treatments: a cell the model never placed is where the
#: observed surface honestly ends, and a cell the silhouette test removed is a surface that
#: continues with its rim taken off. ADR-0010 D4 carries the distinction as one bit rather than
#: as a normal or a radius, on the measurement that load-time tangent frames beat both.
TAG_ONE_SIDED: Final = 0x0001

#: Every bit of the flags channel that is not yet defined. Reserved and validated zero by
#: :func:`exulanica.reconstruction.validation.validate_opm`, so the next flag is a widening of a
#: declared word rather than a reinterpretation of bytes some writer already filled with
#: something else.
RESERVED_TAG_FLAGS: Final = 0xFFFE

#: The largest segment id the container declares, which is the largest the renderer can draw.
#:
#: ADR-0010 D3: "The declared range of a segment id is bounded by what the renderer can actually
#: draw, not by the width of the field." The semantic table in
#: ``web/packages/atlas-react/src/playcanvas/semantics.ts`` holds sixteen entries, the binding
#: raises for a larger id and the shaders index a fixed array, so a file declaring id 900 would
#: be declaring something no renderer in this product can present. The field stays sixteen bits
#: wide because the binding shape is uint16x2; what is bounded is the declared range, and
#: widening it is a change to the table and this constant together.
MAX_SEGMENT_ID: Final = 15

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
    #: 4 bytes per point, rgba, where a is whatever ``colorAlpha`` declares. This producer
    #: writes support.
    color: bytearray
    #: 2 uint16 per point, interleaved: segment id then flags. Interleaved rather than held as
    #: two arrays because it is one vertex attribute of two components, and splitting it here
    #: would mean a per-point pass to weave it back together on the way into the file.
    tags: array
    segments: list[Segment] = field(default_factory=list)
    #: What the producer measured about itself. Never a plausible number.
    statistics: dict[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.position.typecode != "f":
            raise ValueError("position must be an array('f')")
        if self.tags.typecode != "H":
            raise ValueError("tags must be an array('H')")
        count = len(self.position) // 3
        if len(self.position) != count * 3:
            raise ValueError("position is not a whole number of points")
        if len(self.color) != count * 4:
            raise ValueError(f"colour has {len(self.color)} bytes for {count} points")
        if len(self.tags) != count * 2:
            raise ValueError(f"tags has {len(self.tags)} entries for {count} points")
        # Shape only, and no per-point pass. What is IN the two channels is checked by
        # `validate_opm` over the encoded bytes, which is the check that stands between a
        # producer and a durable artifact and which already walks every point once. A second
        # walk here would double the cost of building a map to re-answer a question at the
        # weaker boundary: this constructor is reachable only from inside this package.

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

        Position, then colour, then tags, with no padding between them. That contiguity is
        what lets the PlayCanvas binding hand the engine a zero-copy view of the file: it holds
        one vertex buffer per mesh and computes its own offsets for a tightly packed planar
        format, so a gap anywhere in here costs a per-point CPU repack that the binding correctly
        reports rather than hides.

        The ORDER is the container's, and it is asserted in the header rather than assumed here:
        :func:`exulanica.reconstruction.opm.encode_opm` reads the same section table this follows,
        so a reordering that reached one of the two would fail its own validator.
        """
        return self.position.tobytes() + bytes(self.color) + self.tags.tobytes()

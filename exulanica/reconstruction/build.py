"""A depth prediction becomes a point map, and the pixels it came from become its colour.

The only interesting decision here is which pixels are dropped, and it is the same decision three
times. A point the model could not place is ABSENT from the map rather than placed at a plausible
distance, and the resulting hole is the product's aesthetic rather than a defect to fill:
"the geometry is honestly incomplete", and things end where the camera stopped seeing.

**The third drop is the silhouette, and it exists because a pixel is an area.** A monocular model
returns one point per pixel, and a pixel straddling the edge of the bay tree covers both the tree
and the greenhouse ten metres behind it. Whatever single depth the model returns for it belongs
to neither surface, and the point lands in the empty air between them. Seen from the camera this
is invisible, because it sits exactly along the ray it was measured on; seen from anywhere else
it is a thread of colour strung across the gap, and a photograph's worth of them is the
difference between a reconstruction and a smear. So a point whose depth disagrees with a
neighbour's by more than ``max_depth_step`` is dropped on the same principle as the other two:
nothing measured that surface, so nothing is placed there.

It removes real surface too, one pixel deep along every silhouette, and that is the honest trade
rather than an oversight. The rim it takes belongs to whichever of the two surfaces the model
happened to favour, and there is no way to tell which from a single view.

Colour is sampled from the upright source at the model's own resolution. Nearest-neighbour rather
than an interpolating resize, because a point's colour should be a pixel that exists in the
photograph rather than an average of two that do; a citation opens the original and a viewer
comparing the two should find the colour there.

**The alpha channel carries support, and it used to carry a constant.** The container has always
declared ``colorAlpha: 'confidence'`` and the renderer has always multiplied it into whether a
point survives, but every placed point was written 255, so a wire built to make weak geometry
look weak was delivering a flat "certain" for the sky and the bicycle alike. It now carries how
well sampled the point is: the spacing between it and its neighbours in the world, against the
median spacing of its own map. Sky thirty metres out and pavement running away at a grazing angle
both put metres between adjacent samples and both now say so.

That number is coverage and not belief. ``ConfidenceBand`` in `atlas-core` deliberately cannot
hold a percentage, because a percentage implies a frequency guarantee nothing has calibrated, and
this channel makes no such claim: it reports how much surface one sample was asked to stand for,
which is counted rather than estimated. **OPM/2 says so in the header**: ``colorAlpha`` is now an
enum and this producer declares ``support``, so a renderer that sizes a sprite by coverage is no
longer telling itself that it read a confidence.

**A survivor beside a dropped point is marked, and this is the one thing the renderer cannot work
out for itself.** ADR-0010 D4 adds bit 0 of the tags flags channel: this point had a four-
neighbour removed by the silhouette test above. A loader that rebuilds the image lattice by
reprojecting every point through the header's own camera can already see that the cell beside
this one is empty, and it cannot see why. An empty cell the model never placed is where the
observed surface honestly ends; an empty cell this stage took is a surface that continues with
its rim removed, and the two want opposite treatments when a tangent frame is estimated from
neighbours. Only this stage knows which it was, because only this stage still has the point it
dropped.

**A pixel at the edge of the grid is NOT marked**, and the distinction is the whole value of the
flag. It has fewer neighbours because the photograph ends, which is a fact a loader can see for
itself from the lattice. Marking it here would make bit 0 mean "this point has a missing
neighbour", which is the thing that needed no help.
"""

from __future__ import annotations

import math
from array import array
from statistics import median
from typing import Final

from PIL import Image

from exulanica.reconstruction.depth import DepthPrediction
from exulanica.reconstruction.pointmap import TAG_ONE_SIDED, PointMap, Segment

__all__ = ["DEFAULT_MAX_DEPTH_STEP", "DEFAULT_SEGMENT", "build_point_map"]

#: UNVALIDATED DEFAULT, but not an arbitrary one. Measured on the glasshouse courtyard at 512 px:
#: at 0.10 the test fires on 3.05% of points and traces silhouettes only, leaving the receding
#: pavement whole; at 0.05 it fires on 4.44% and begins deleting the frame and wheel rims of a
#: bicycle standing proud of a wall, which is real surface belonging to a thing the graph cites.
#: One photograph is not a corpus, which is why this is a parameter of the stage rather than a
#: constant anybody has to edit, and why the number above is written down with what it was
#: measured on rather than presented as a property of the world.
DEFAULT_MAX_DEPTH_STEP: Final = 0.10

#: One segment, and it is honest about being one. A monocular depth model returns geometry, not
#: semantics; a producer that wrote `ground`, `structure` and `person` here would be labelling
#: surfaces nothing had classified.
DEFAULT_SEGMENT = Segment(id=0, name="unsegmented", cls="structure")

#: Full support: a sample no more coarsely spaced than the median of its own map.
_FULL_SUPPORT: Final = 255


def _sample_spacing(prediction: DepthPrediction) -> list[float]:
    """How far apart this sample and its grid neighbours landed in the world, per pixel.

    This is the honest measure of how much surface one point is being asked to stand for, and it
    is one quantity rather than three because range and grazing angle are the same fact seen
    twice: a pavement running away from the camera and a wall thirty metres back both put metres
    between adjacent samples, and both are equally unsupported however confident the model was.

    ``inf`` for a pixel with no valid neighbour, which is a sample standing entirely alone.
    """
    width = prediction.width
    height = prediction.height
    points = prediction.points
    valid = prediction.valid
    total = width * height

    summed = [0.0] * total
    counted = [0] * total

    def measure(a: int, b: int) -> None:
        if not valid[a] or not valid[b]:
            return
        ax, ay, az = points[a * 3], points[a * 3 + 1], points[a * 3 + 2]
        bx, by, bz = points[b * 3], points[b * 3 + 1], points[b * 3 + 2]
        distance = math.sqrt((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2)
        summed[a] += distance
        summed[b] += distance
        counted[a] += 1
        counted[b] += 1

    for y in range(height):
        row = y * width
        for x in range(width - 1):
            measure(row + x, row + x + 1)
    for index in range(total - width):
        measure(index, index + width)

    return [
        summed[index] / counted[index] if counted[index] else math.inf for index in range(total)
    ]


def _support(spacing: list[float], reference: float) -> list[int]:
    """The alpha channel: how well sampled a point is, against the median of its own map.

    Relative to the map rather than to a constant, because there is no universal spacing a point
    ought to have: it falls out of the model's output resolution, the lens and how far away the
    surface was. A point at the median gets full support; one standing for four times the spacing
    gets a quarter, and the median travels in the statistics so the number can be read back.

    Deliberately NOT a probability. ``ConfidenceBand`` in `atlas-core` refuses to hold a
    percentage because that would imply a frequency guarantee nothing has calibrated, and this
    channel makes no such claim either. It reports coverage, which is counted, not belief.
    """
    if not (reference > 0.0 and math.isfinite(reference)):
        return [_FULL_SUPPORT] * len(spacing)
    out: list[int] = []
    for value in spacing:
        if not math.isfinite(value) or value <= 0.0:
            out.append(0 if math.isinf(value) else _FULL_SUPPORT)
            continue
        out.append(min(_FULL_SUPPORT, round(_FULL_SUPPORT * reference / value)))
    return out


def _bridges_discontinuity(prediction: DepthPrediction, max_depth_step: float) -> bytearray:
    """One byte per pixel, non-zero where a point sits across a depth discontinuity.

    The test is the RELATIVE step to a four-neighbour, not an absolute one in metres. Depth error
    grows with depth, and a fixed threshold would either spare every silhouette in the far half
    of the frame or shred the near half; the ratio is scale free and so behaves the same at three
    metres and at thirty.

    Both sides of the step are marked. Only one of the two is the interpolated point, and from a
    single view there is nothing that says which: the near surface and the far surface each have
    an equal claim on a pixel that covers some of both.
    """
    width = prediction.width
    height = prediction.height
    points = prediction.points
    valid = prediction.valid
    total = width * height

    # Depth, not z. The frame is -Z forward, so a surface in front of the camera has a negative
    # z and a positive depth, and every comparison below is between two positive numbers.
    depth = [-points[index * 3 + 2] for index in range(total)]
    flagged = bytearray(total)
    ratio = 1.0 + max_depth_step

    def mark(a: int, b: int) -> None:
        if not valid[a] or not valid[b]:
            return
        near = depth[a]
        far = depth[b]
        if far < near:
            near, far = far, near
        # A non-positive depth has no ratio to take. It should not occur for a point the model
        # marked valid, and passing over it is the reading that cannot invent a discontinuity.
        if near > 0.0 and far > ratio * near:
            flagged[a] = 1
            flagged[b] = 1

    for y in range(height):
        row = y * width
        for x in range(width - 1):
            mark(row + x, row + x + 1)
    for index in range(total - width):
        mark(index, index + width)
    return flagged


def build_point_map(
    prediction: DepthPrediction,
    source: Image.Image,
    *,
    max_depth_step: float | None = DEFAULT_MAX_DEPTH_STEP,
) -> PointMap:
    """Placed points only, coloured from the photograph they were recovered from.

    ``max_depth_step`` is the largest relative depth disagreement a point may have with a
    neighbour before it is treated as spanning a silhouette rather than lying on a surface.
    ``None`` keeps every placed point, which is what a caller comparing against the unfiltered
    map passes and what the container's own decoder tests use.
    """
    if max_depth_step is not None and not max_depth_step > 0.0:
        raise ValueError(f"max_depth_step must be positive or None, got {max_depth_step}")
    bridging = (
        None if max_depth_step is None else _bridges_discontinuity(prediction, max_depth_step)
    )

    # Measured before the drop loop, over every pixel the model placed. The reference has to
    # describe the whole recovered surface rather than whatever survived filtering, or the
    # silhouette drop would quietly move the scale that every support value is read against.
    spacing = _sample_spacing(prediction)
    surveyed = sorted(value for value in spacing if math.isfinite(value))
    reference = median(surveyed) if surveyed else math.inf
    support = _support(spacing, reference)

    rgb = source.convert("RGB")
    if rgb.size != (prediction.width, prediction.height):
        rgb = rgb.resize((prediction.width, prediction.height), Image.Resampling.NEAREST)
    pixels = rgb.tobytes()

    positions = array("f")
    colours = bytearray()
    tags = array("H")

    width = prediction.width
    height = prediction.height
    bridged = 0
    one_sided = 0
    support_total = 0
    for index in range(width * height):
        if not prediction.valid[index]:
            continue
        if bridging is not None and bridging[index]:
            bridged += 1
            continue
        base = index * 3
        positions.extend(prediction.points[base : base + 3])
        colours += pixels[base : base + 3]
        colours.append(support[index])
        support_total += support[index]
        flags = 0
        if bridging is not None and _lost_a_neighbour(bridging, index, width, height):
            flags |= TAG_ONE_SIDED
            one_sided += 1
        tags.append(DEFAULT_SEGMENT.id)
        tags.append(flags)

    placed = len(tags) // 2
    total = prediction.width * prediction.height
    return PointMap(
        position=positions,
        color=colours,
        tags=tags,
        segments=[DEFAULT_SEGMENT],
        # Measured, not estimated, and every number here describes THIS FILE rather than the
        # prediction behind it. The two now differ: the quality gate reads the prediction's own
        # `valid_fraction`, which counts what the model placed, while `validFraction` below
        # counts what survived to be written. `discontinuityDropped` is the whole of the
        # difference, so a reader can recover one from the other instead of finding two
        # disagreeing fractions and having to guess which question each answered.
        statistics={
            "sourcePixels": float(total),
            "placedPoints": float(placed),
            "validFraction": 0.0 if total == 0 else placed / total,
            "discontinuityDropped": float(bridged),
            # The scale the alpha channel is read against. Without it a reader has a column of
            # ratios and no denominator, which is a number that cannot be checked.
            "medianSampleSpacingM": 0.0 if math.isinf(reference) else reference,
            "meanSupport": 0.0 if placed == 0 else support_total / (placed * _FULL_SUPPORT),
            # How many survivors carry bit 0. Recorded because the flag's whole justification is
            # a measurement that has been taken on one map: ADR-0010 D4 puts it at "about a
            # tenth of a percent of points" and says outright that whether it removes the
            # fringing "is the thing to measure before writing it". A number per file is what
            # makes that measurable on the next one.
            "oneSidedPoints": float(one_sided),
        },
    )


def _lost_a_neighbour(bridging: bytearray, index: int, width: int, height: int) -> bool:
    """Was a four-neighbour of this pixel dropped by the silhouette test?

    Four-neighbour rather than eight, because that is the lattice a load-time tangent frame is
    estimated on: the row and column neighbours are the two half-extents, and a diagonal
    contributes to neither.

    Grid edges are not neighbours and their absence is not a drop. See the module docstring: a
    point at the border of the photograph is missing a neighbour for a reason a loader can work
    out from the lattice, and folding that in here would cost the flag its meaning.
    """
    row, column = divmod(index, width)
    if column > 0 and bridging[index - 1]:
        return True
    if column + 1 < width and bridging[index + 1]:
        return True
    if row > 0 and bridging[index - width]:
        return True
    return row + 1 < height and bridging[index + width]

"""A depth prediction becomes a point map, and the pixels it came from become its colour.

The only interesting decision here is which pixels are dropped, and it is the same decision twice.
A point the model could not place is ABSENT from the map rather than placed at a plausible
distance, and the resulting hole is the product's aesthetic rather than a defect to fill:
"the geometry is honestly incomplete", and things end where the camera stopped seeing.

Colour is sampled from the upright source at the model's own resolution. Nearest-neighbour rather
than an interpolating resize, because a point's colour should be a pixel that exists in the
photograph rather than an average of two that do; a citation opens the original and a viewer
comparing the two should find the colour there.
"""

from __future__ import annotations

from array import array

from PIL import Image

from orimera.reconstruction.depth import DepthPrediction
from orimera.reconstruction.pointmap import PointMap, Segment

__all__ = ["DEFAULT_SEGMENT", "build_point_map"]

#: One segment, and it is honest about being one. A monocular depth model returns geometry, not
#: semantics; a producer that wrote `ground`, `structure` and `person` here would be labelling
#: surfaces nothing had classified.
DEFAULT_SEGMENT = Segment(id=0, name="unsegmented", cls="structure")

#: Confidence, in the alpha channel. A model that returns a per-point confidence should write it;
#: MoGe returns a mask rather than a score, so every placed point carries the same value and the
#: file says what the channel means rather than leaving a reader to guess it is opacity.
_PLACED_CONFIDENCE = 255


def build_point_map(prediction: DepthPrediction, source: Image.Image) -> PointMap:
    """Placed points only, coloured from the photograph they were recovered from."""
    rgb = source.convert("RGB")
    if rgb.size != (prediction.width, prediction.height):
        rgb = rgb.resize((prediction.width, prediction.height), Image.Resampling.NEAREST)
    pixels = rgb.tobytes()

    positions = array("f")
    colours = bytearray()
    segments = array("H")

    for index in range(prediction.width * prediction.height):
        if not prediction.valid[index]:
            continue
        base = index * 3
        positions.extend(prediction.points[base : base + 3])
        colours += pixels[base : base + 3]
        colours.append(_PLACED_CONFIDENCE)
        segments.append(DEFAULT_SEGMENT.id)

    placed = len(segments)
    total = prediction.width * prediction.height
    return PointMap(
        position=positions,
        color=colours,
        segment=segments,
        segments=[DEFAULT_SEGMENT],
        # Measured, not estimated. `valid_fraction` is what the quality gate reads and what the
        # interface would have to show to explain a rung, so it travels with the file.
        statistics={
            "sourcePixels": float(total),
            "placedPoints": float(placed),
            "validFraction": 0.0 if total == 0 else placed / total,
        },
    )

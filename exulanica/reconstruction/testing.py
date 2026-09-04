"""A depth model that invents nothing and is not pretending to be one.

Every test of the reconstruction stage runs against this rather than against MoGe, and the whole
ingest suite runs with no torch, no weights and no download. That is the same arrangement the
vision stage has, and for the same reason: a suite that needed a 1.3 GB checkpoint is a suite
that stops being run.

**It is a plane, and it is named after being one.** It places every pixel on a fronto-parallel
surface at a fixed distance, which is geometrically the least interesting thing a depth model
could return and is exactly right for testing the plumbing: the container, the packing, the
colour sampling, the gate and the stage key all behave identically whatever the depths are. A
double that produced convincing-looking depth would invite somebody to read a test of the
plumbing as a test of the reconstruction.

``valid_fraction`` is settable, because the one thing the gate actually reads is how much of the
frame was placed, and a test of the rung 4 branch needs a prediction that placed almost nothing.
"""

from __future__ import annotations

from PIL import Image

from exulanica.reconstruction.depth import DepthPrediction

__all__ = ["FlatDepthModel"]


class FlatDepthModel:
    """A plane at a fixed distance. Deterministic, instant, and obviously not a reconstruction."""

    def __init__(
        self,
        *,
        distance_m: float = 4.0,
        fov_y_degrees: float = 55.0,
        valid_fraction: float = 1.0,
        max_edge: int = 64,
    ) -> None:
        self.distance_m = distance_m
        self.fov_y_degrees = fov_y_degrees
        self.valid_fraction = valid_fraction
        self.max_edge = max_edge

    @property
    def model_id(self) -> str:
        return "flat-plane-double"

    def predict(self, image: Image.Image) -> DepthPrediction:
        width, height = _scaled(image.size, self.max_edge)
        total = width * height
        # Placed pixels are the first N in row-major order rather than a scatter, so a test that
        # asks for a fraction gets exactly that fraction and not a sample of it.
        placed = round(total * self.valid_fraction)
        valid = bytes([1] * placed + [0] * (total - placed))

        points: list[float] = []
        for index in range(total):
            row, column = divmod(index, width)
            # A plane at -Z, with x and y spanning a metre either side so the map has an extent
            # to report. Nothing here is a measurement and nothing pretends to be.
            points.extend(
                (
                    (column / max(1, width - 1)) * 2.0 - 1.0,
                    1.0 - (row / max(1, height - 1)) * 2.0,
                    -self.distance_m,
                )
            )
        return DepthPrediction(
            width=width,
            height=height,
            points=points,
            valid=valid,
            fov_y_degrees=self.fov_y_degrees,
            metric=True,
            model_id=self.model_id,
        )


def _scaled(size: tuple[int, int], max_edge: int) -> tuple[int, int]:
    width, height = size
    longest = max(width, height)
    if longest <= max_edge:
        return (max(1, width), max(1, height))
    scale = max_edge / longest
    return (max(1, round(width * scale)), max(1, round(height * scale)))

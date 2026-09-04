"""What a monocular depth model is, to this pipeline.

One protocol with two implementations, exactly as the vision stage does it: a real model behind
an interface, and a deterministic double. That shape is what lets the ingest pipeline be tested
end to end with no GPU, no weights and no download, and it is what lets an instance with no model
installed still ingest a corpus and report the stage as not run rather than faking it.

**The prediction carries its own honesty.** ``metric`` says whether the model recovered true
scale; ``valid`` is the per-point mask, because a monocular model is not defined at the sky and
saying so is different from placing a point at infinity. A prediction that flattened either into
a plausible default would push the decision into the caller, and the caller does not know.

**Nothing here is a citation.** This module does not import the evidence layer and must not. A
depth prediction is a description of what a photograph appears to contain; the photograph itself
is the evidence, and the two must never become interchangeable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from PIL import Image

__all__ = ["DepthModel", "DepthPrediction"]


@dataclass(frozen=True, slots=True)
class DepthPrediction:
    """One image's recovered geometry, in the camera's own frame.

    ``points`` is row-major, three floats per pixel, in metres, +Y up and -Z forward, at the
    resolution the model chose rather than the source's. ``valid`` is one byte per pixel and is
    what makes the holes real: a point the model could not place is absent from the map instead
    of being placed at a plausible distance.
    """

    width: int
    height: int
    #: 3 floats per pixel, row-major.
    points: list[float]
    #: 1 byte per pixel: non-zero where the model recovered a position.
    valid: bytes
    #: Vertical field of view, degrees. Recovered by the model or read from the file.
    fov_y_degrees: float
    #: True when the model recovered TRUE SCALE. False means shape up to an unknown factor, and
    #: an island built from it is not metric, so a spatial question refuses rather than estimates.
    metric: bool
    #: What produced this, echoed from the model. Goes into the container's `generator`
    #: field and into the recorded rung, and nowhere else.
    model_id: str

    def __post_init__(self) -> None:
        expected = self.width * self.height
        if len(self.points) != expected * 3:
            raise ValueError(f"points has {len(self.points)} floats for {expected} pixels")
        if len(self.valid) != expected:
            raise ValueError(f"valid has {len(self.valid)} bytes for {expected} pixels")

    @property
    def valid_fraction(self) -> float:
        """How much of the frame the model placed. The quality gate's only input."""
        total = self.width * self.height
        return 0.0 if total == 0 else sum(1 for byte in self.valid if byte) / total


@runtime_checkable
class DepthModel(Protocol):
    """Predict geometry for one upright image.

    ``model_id`` is read BEFORE the call, because it is part of the stage's idempotency key:
    swapping the weights changes what the stage produces, and a corpus keyed as though nothing had
    changed would never reprocess. That is the same rule the vision stage follows and the same
    reason it follows it.

    The image arrives ALREADY UPRIGHT. Orientation is normalised once at ingest and every later
    stage works from display space; a model handed sensor pixels would recover a sideways room
    and every point in it would be rotated by a right angle with nothing to say so.
    """

    @property
    def model_id(self) -> str: ...

    def predict(self, image: Image.Image) -> DepthPrediction: ...

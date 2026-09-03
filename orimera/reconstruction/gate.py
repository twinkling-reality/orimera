"""The quality gate: which rung a region actually earned.

``product-specification.md`` section 5 defines four rungs and says the gate runs automatically and
the Atlas renders whichever rung the region earned. This is that gate for the single-photograph
path, and what it can and cannot award is worth stating plainly rather than implying.

**It can award rung 3 or rung 4, and nothing else, and that is now a statement about its INPUT
rather than about what exists.** This function sees one ``DepthPrediction`` from one photograph.
Rung 1 needs structure from motion and a trained splat, and rung 2 needs recovered poses and a
coverage analysis over them; both are facts about a set of photographs, and neither can be read
off a single frame however the branches were written. So this gate does not grow those branches.
The rungs above 3 are decided by the quality receipts their own controllers return, over a scene
rather than over a capture, and a gate with unreachable branches that look reachable is how a
system ends up claiming a rung it never earned.

**Rung 3 has "no gate that can fail", and this does not contradict that.** The specification's
claim is that monocular depth is DEFINED for every image, and it is. What it does not promise is
that every image contains something to place: a photograph of an overcast sky has a valid mask
covering almost nothing, and there is no geometry to walk through in it. That region gets rung 4,
which is a real rung with a real experience rather than a failure, and its photographs still open.

**The threshold is an unvalidated default and is recorded as one.** It sits in the stage's
parameters rather than in a constant here, so changing it changes the stage's idempotency key and
regenerates rather than leaving stale rungs behind. The number itself has not been measured
against a corpus, and the honest place to say so is beside it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from orimera.reconstruction.depth import DepthPrediction

__all__ = ["MIN_VALID_FRACTION", "RungDecision", "decide_rung"]

#: UNVALIDATED DEFAULT. A frame where the model placed less than this is one with too little
#: recovered surface to walk through. Chosen as a starting point rather than measured; the corpus
#: that would validate it is the thing this pipeline is being built to produce.
MIN_VALID_FRACTION: Final = 0.15


@dataclass(frozen=True, slots=True)
class RungDecision:
    """Which rung, and the measurement that decided it.

    The reason is carried because the rung is DISPLAYED. "This region has no geometry" is a
    sentence a user may reasonably ask a question about, and an interface that could only say the
    rung and not why would be showing a verdict with no evidence, in a product whose whole claim
    is the opposite.
    """

    rung: int
    valid_fraction: float
    reason: str

    def as_payload(self) -> dict[str, object]:
        return {
            "rung": self.rung,
            "valid_fraction": round(self.valid_fraction, 4),
            "reason": self.reason,
        }


def decide_rung(
    prediction: DepthPrediction, *, min_valid_fraction: float = MIN_VALID_FRACTION
) -> RungDecision:
    """Rung 3 when there is enough recovered surface to stand in, rung 4 when there is not."""
    fraction = prediction.valid_fraction
    if fraction < min_valid_fraction:
        return RungDecision(
            rung=4,
            valid_fraction=fraction,
            reason="too little of the frame could be placed to make a region to move through",
        )
    return RungDecision(
        rung=3,
        valid_fraction=fraction,
        reason="a per-image point map with real depth relief, seen from where the camera stood",
    )

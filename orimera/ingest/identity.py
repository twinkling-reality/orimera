"""The occurrence identity key: derived from the evidence, never from a pipeline row.

This is the part that is normally got wrong, and getting it wrong has a specific symptom. If a
rejection is keyed by ``occurrence_id``, the next detector run mints a new ``occurrence_id`` for
the same thing in the same photograph, the rejected proposal comes straight back, and the user
re-rejects the same match forever. The product feels broken and the cause is invisible.

So the key is a function of the address:

    sha256(blob_sha256, track_key, floor(t_start/250ms), floor(t_end/250ms), class, region
    bucket on a 16x16 grid)

For a photograph both time buckets are zero, so the key reduces to blob, track, class and
region bucket, and it is stable across detector versions by construction.
"""

from __future__ import annotations

import hashlib
from typing import Final

from orimera.evidence import EvidenceAddress
from orimera.evidence.region import PPM, Rect

__all__ = ["REGION_GRID", "TIME_BUCKET_NS", "occurrence_identity_key", "region_bucket"]

#: 250 ms, per the domain model. Constant for a photograph corpus; present so the video path
#: needs no second implementation.
TIME_BUCKET_NS: Final = 250_000_000
#: A 16x16 grid over the normalised image. Coarse on purpose: the point is that two runs of
#: two detector versions land in the same cell, not that the cell is precise.
REGION_GRID: Final = 16


def region_bucket(rect: Rect | None) -> str:
    """The grid cell a region falls in, or ``'null'`` for a whole-image occurrence.

    Bucketed by the box centre rather than its origin. A detector version that trims a box
    tightly moves the origin by more than it moves the centre, and the whole purpose of the
    bucket is to survive exactly that.
    """
    if rect is None:
        return "null"
    centre_x = rect.x_ppm + rect.w_ppm // 2
    centre_y = rect.y_ppm + rect.h_ppm // 2
    column = min(REGION_GRID - 1, centre_x * REGION_GRID // PPM)
    row = min(REGION_GRID - 1, centre_y * REGION_GRID // PPM)
    return f"{column}:{row}"


def occurrence_identity_key(address: EvidenceAddress, occurrence_class: str) -> bytes:
    """32 bytes derived only from the evidence address and the occurrence class."""
    rect = address.region.rect if address.region is not None else None
    parts = (
        address.blob_id.hex,
        address.track_key,
        str(address.interval.start_ns // TIME_BUCKET_NS),
        str(address.interval.end_ns // TIME_BUCKET_NS),
        occurrence_class,
        region_bucket(rect),
    )
    hasher = hashlib.sha256()
    for part in parts:
        # Length-prefixed, so ('ab', 'c') and ('a', 'bc') cannot collide. A concatenation
        # without separators is a collision waiting for a label that contains the separator.
        hasher.update(len(part).to_bytes(4, "big"))
        hasher.update(part.encode("utf-8"))
    return hasher.digest()

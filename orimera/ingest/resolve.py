"""Cropping an address's region out of the original, the way ingest normalised it.

The rest of address resolution lives in :mod:`orimera.store.resolve`, which the read path uses
and which knows nothing about ingestion. This one function stays here because it is not really
about resolution: it is about undoing the same EXIF orientation transform ingest applied, and
that transform is defined in this package. Cropping the stored pixels without it is how a
correct address produces a picture of the wrong part of the photograph.
"""

from __future__ import annotations

import io

from PIL import Image

from orimera.evidence import EvidenceAddress
from orimera.evidence.region import PPM
from orimera.store.base import ContentAddressedStore
from orimera.store.resolve import resolve_original_bytes

__all__ = ["resolve_region_image"]


def resolve_region_image(address: EvidenceAddress, store: ContentAddressedStore) -> Image.Image:
    """Crop an address's region out of the original, in display space.

    Orientation is applied here exactly as it was at ingest, because the region was normalised
    against the upright image. Cropping the stored pixels without that step is how a correct
    address produces a picture of the wrong part of the photograph.
    """
    from orimera.ingest.exif import normalise_orientation  # local: avoids an import cycle

    with Image.open(io.BytesIO(resolve_original_bytes(address, store))) as opened:
        opened.load()
        upright, _ = normalise_orientation(opened)
        upright = upright.convert("RGB")
    if address.region is None:
        return upright
    rect = address.region.rect
    width, height = upright.size
    left = rect.x_ppm * width // PPM
    top = rect.y_ppm * height // PPM
    right = max(left + 1, (rect.x_ppm + rect.w_ppm) * width // PPM)
    bottom = max(top + 1, (rect.y_ppm + rect.h_ppm) * height // PPM)
    return upright.crop((left, top, right, bottom))

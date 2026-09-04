"""Cropping an address's region out of the original, the way ingest normalised it.

The rest of address resolution lives in :mod:`exulanica.store.resolve`, which the read path uses
and which knows nothing about ingestion. This one function stays here because it is not really
about resolution: it is about undoing the same EXIF orientation transform ingest applied, and
that transform is defined in this package. Cropping the stored pixels without it is how a
correct address produces a picture of the wrong part of the photograph.

**The decode goes through :mod:`exulanica.ingest.decode` and must.** This file used to call
``Image.open`` and ``load()`` itself, which put a second decode path on the same 40-thread
request pool with no pixel comparison in front of it. It was not unprotected, but the protection
was an accident: importing anything under ``exulanica.ingest`` runs the package's ``__init__``,
which reaches ``decode``, which assigns ``Image.MAX_IMAGE_PIXELS`` process-wide. Measured: with
that state installed, a header at 1.031x the budget was refused here; after
``warnings.resetwarnings()``, the same bare ``Image.open`` returned an image, while
``decode.probe`` on the identical bytes still refused. Depending on an import having happened is
not a bound, so this asks for the bound by name.
"""

from __future__ import annotations

from PIL import Image

from exulanica.evidence import EvidenceAddress
from exulanica.evidence.region import PPM
from exulanica.ingest.decode import open_upright
from exulanica.store.base import ContentAddressedStore
from exulanica.store.resolve import resolve_original_bytes

__all__ = ["resolve_region_image"]


def resolve_region_image(address: EvidenceAddress, store: ContentAddressedStore) -> Image.Image:
    """Crop an address's region out of the original, in display space.

    Orientation is applied here exactly as it was at ingest, because the region was normalised
    against the upright image, and "exactly as" is literal: this is the call ingest makes, not a
    reimplementation of it. The facts it returns alongside the pixels are discarded, and that is
    the price of there being one decode rather than two that have to be kept in step.
    """
    upright, _ = open_upright(resolve_original_bytes(address, store))
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

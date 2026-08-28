"""Resolving an evidence address back to the original bytes.

This is the closing half of the contract. An address is worth having only if it opens, and it
must open against **original media**, never against a rendition, a thumbnail or any other
derivative. The rendition exists so a model can look at something small; it is not what a
citation resolves to, and there is no function in this module that returns one.

``address_from_span_row`` exists to prove the round trip: a span read back out of the database
reconstructs an address whose digest equals the digest that was stored. If that ever stops
being true, every citation token in every archived answer has silently stopped verifying, and
this is the cheapest place to find out.
"""

from __future__ import annotations

import io
import json
import sqlite3
from typing import Any

from PIL import Image

from orimera.errors import IntegrityError
from orimera.evidence import EvidenceAddress, Modality, TimeInterval
from orimera.evidence.blob import BlobId
from orimera.evidence.region import PPM, DisplayGeometry, Rect, Region
from orimera.store.base import ContentAddressedStore

__all__ = ["address_from_span_row", "resolve_original_bytes", "resolve_region_image"]


def address_from_span_row(row: sqlite3.Row | dict[str, Any]) -> EvidenceAddress:
    """Rebuild an address from a stored span. The digest must come out identical."""
    data = dict(row)
    region_json = data.get("region")
    region = None
    if region_json:
        parsed = json.loads(region_json)
        rect = parsed["rect"]
        display = parsed["display"]
        region = Region(
            rect=Rect(rect["x"], rect["y"], rect["w"], rect["h"]),
            display=DisplayGeometry(
                w=display["w"],
                h=display["h"],
                rotation=display["rotation"],
                sar_num=display["sar_num"],
                sar_den=display["sar_den"],
            ),
            kind=parsed.get("kind", "rect"),
        )
    address = EvidenceAddress(
        blob_id=BlobId(bytes(data["blob_sha256"])),
        track_key=data["track_key"],
        interval=TimeInterval(int(data["t_start_ns"]), int(data["t_end_ns"])),
        modality=Modality(data["modality"]),
        region=region,
        span_format_version=int(data["span_format_version"]),
    )
    stored = bytes(data["span_digest"])
    if address.span_digest != stored:
        raise IntegrityError(
            f"span {data.get('span_id')} rebuilt to digest {address.span_digest_hex} but was "
            f"stored as {stored.hex()}. Every citation token verified against the stored "
            "digest would now fail."
        )
    return address


def resolve_original_bytes(address: EvidenceAddress, store: ContentAddressedStore) -> bytes:
    """The original bytes an address points at, hash-verified on the way out.

    ``store.get`` re-hashes what it read, so a citation cannot resolve to content that is not
    what the address names. That check is the difference between a citation and a link.
    """
    return store.get(address.blob_id)


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

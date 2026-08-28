"""The evidence spine.

An evidence address is ``(content hash of the original bytes, track key, exact rational time
interval)`` and nothing else. Reconstruction, thumbnails, transcripts and embeddings are views;
this package holds the only thing a factual claim is allowed to resolve against.
"""

from __future__ import annotations

from orimera.evidence.address import (
    IMAGE_TRACK_KEY,
    SPAN_FORMAT_VERSION,
    URI_SCHEME,
    EvidenceAddress,
    Modality,
    TextAnchor,
    parse_uri,
)
from orimera.evidence.blob import DIGEST_BYTES, HASH_ALGORITHM, BlobId
from orimera.evidence.region import PPM, DisplayGeometry, Rect, Region
from orimera.evidence.timebase import (
    IMAGE_TIME_BASE,
    NS_PER_SECOND,
    PHOTOGRAPH_INTERVAL,
    TimeBase,
    TimeInterval,
    ns_to_seconds,
    seconds_to_ns,
)

__all__ = [
    "DIGEST_BYTES",
    "HASH_ALGORITHM",
    "IMAGE_TIME_BASE",
    "IMAGE_TRACK_KEY",
    "NS_PER_SECOND",
    "PHOTOGRAPH_INTERVAL",
    "PPM",
    "SPAN_FORMAT_VERSION",
    "URI_SCHEME",
    "BlobId",
    "DisplayGeometry",
    "EvidenceAddress",
    "Modality",
    "Rect",
    "Region",
    "TextAnchor",
    "TimeBase",
    "TimeInterval",
    "ns_to_seconds",
    "parse_uri",
    "seconds_to_ns",
]

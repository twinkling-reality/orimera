"""The evidence spine.

An evidence address is ``(content hash of the original bytes, track key, exact rational time
interval)`` and nothing else. Reconstruction, thumbnails, transcripts and embeddings are views;
this package holds the only thing a factual claim is allowed to resolve against.
"""

from __future__ import annotations

from exulanica.evidence.address import (
    IMAGE_TRACK_KEY,
    SPAN_FORMAT_VERSION,
    URI_SCHEME,
    EvidenceAddress,
    Modality,
    TextAnchor,
    parse_uri,
)
from exulanica.evidence.blob import DIGEST_BYTES, HASH_ALGORITHM, BlobId
from exulanica.evidence.region import PPM, DisplayGeometry, Rect, Region
from exulanica.evidence.scene import (
    SCENE_DIGEST_VERSION,
    SCENE_NAMESPACE,
    scene_id_for,
    scene_member_digest,
)
from exulanica.evidence.timebase import (
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
    "SCENE_DIGEST_VERSION",
    "SCENE_NAMESPACE",
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
    "scene_id_for",
    "scene_member_digest",
    "seconds_to_ns",
]

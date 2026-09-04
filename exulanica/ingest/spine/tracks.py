"""What the container says about the samples, and where sample zero sits on the wall clock.

``media_track`` is keyed on the content hash and ``clock_anchor`` on the track it anchors, and
neither carries a ``workspace_id``, for the same reason ``blob`` does not: two people importing
one file observe one container, and a second row would be a second answer to a question the
bytes already settle. They are one module because a track with no anchor is a track whose
``t_ns`` axis is floating: the anchor is the only thing that ties sample zero to an instant, and
separating them would put the two halves of one fact in two files.
"""

from __future__ import annotations

import uuid
from typing import Any

from psycopg.types.json import Jsonb

from exulanica.evidence.blob import BlobId
from exulanica.ingest.spine.scope import WorkspaceScope

__all__ = ["insert_clock_anchor", "upsert_image"]


def upsert_image(
    scope: WorkspaceScope,
    blob_id: BlobId,
    *,
    coded_w: int,
    coded_h: int,
    disp_w: int,
    disp_h: int,
    rotation: int,
    codec: str,
    probe_json: dict[str, Any],
) -> uuid.UUID:
    """Register the single-sample ``img`` track a photograph is modelled as.

    ``time_base 1/1_000_000_000``, ``start_pts 0``, ``duration_ns 1``. The interval exists even
    though a photograph has no duration, so the overlap, tombstone and co-presence paths are
    exercised by this corpus rather than left untested until video arrives.
    """
    row = scope.connection.execute(
        "insert into media_track (blob_sha256, track_key, kind, time_base_num, "
        "time_base_den, start_pts, duration_ns, coded_w, coded_h, disp_w, disp_h, rotation, "
        "sar_num, sar_den, codec, probe_json) "
        "values (%s, 'img', 'image', 1, 1000000000, 0, 1, %s, %s, %s, %s, %s, 1, 1, %s, %s) "
        "on conflict (blob_sha256, track_key) do nothing returning track_id",
        (blob_id.digest, coded_w, coded_h, disp_w, disp_h, rotation, codec, Jsonb(probe_json)),
    ).fetchone()
    if row is not None:
        return row["track_id"]
    existing = scope.connection.execute(
        "select track_id from media_track where blob_sha256 = %s and track_key = 'img'",
        (blob_id.digest,),
    ).fetchone()
    assert existing is not None
    return existing["track_id"]


def insert_clock_anchor(
    scope: WorkspaceScope,
    track_id: uuid.UUID,
    *,
    utc_instant: str,
    source: str,
    uncertainty_ms: int,
) -> None:
    """Pin ``t_ns = 0`` on this track to a wall-clock instant, with the source that claimed it."""
    scope.connection.execute(
        "insert into clock_anchor (track_id, t_ns, utc_instant, source, uncertainty_ms) "
        "values (%s, 0, %s, %s, %s) on conflict (track_id, t_ns, source) do nothing",
        (track_id, utc_instant, source, uncertainty_ms),
    )

"""One photograph as this workspace holds it, and what the corpus knows about when it was taken.

``capture`` is the workspace-scoped side of ``blob``: the bytes are shared, the fact that this
person imported them is not. Every read here is filtered on ``workspace_id`` in the statement as
well as by row-level security, because a query that relies only on the policy is a query that
returns everything the day it is run as a superuser, and the suite runs as one.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from exulanica.evidence.blob import BlobId
from exulanica.ingest.spine.scope import WorkspaceScope

__all__ = ["CaptureRow", "by_id", "insert", "live_for_blob", "with_context"]

_COLUMNS = "capture_id, blob_sha256, device_id, started_at, deleted_at"


@dataclass(frozen=True, slots=True)
class CaptureRow:
    capture_id: uuid.UUID
    blob_id: BlobId
    device_id: str | None
    started_at: str | None
    deleted_at: str | None


def _iso(value: Any) -> str | None:
    """Render a ``timestamptz`` as ISO 8601, or pass through what is already a string.

    Connections are pinned to UTC, so this is a UTC rendering and the field names that call it
    ``utc`` are telling the truth.
    """
    return None if value is None else (value if isinstance(value, str) else value.isoformat())


def _row(row: Mapping[str, Any]) -> CaptureRow:
    return CaptureRow(
        capture_id=row["capture_id"],
        blob_id=BlobId(bytes(row["blob_sha256"])),
        device_id=row["device_id"],
        started_at=_iso(row["started_at"]),
        deleted_at=_iso(row["deleted_at"]),
    )


def live_for_blob(scope: WorkspaceScope, blob_id: BlobId) -> CaptureRow | None:
    """The live capture this workspace holds for these bytes, or None."""
    row = scope.connection.execute(
        f"select {_COLUMNS} from capture "
        "where workspace_id = %s and blob_sha256 = %s and deleted_at is null",
        (scope.workspace_id, blob_id.digest),
    ).fetchone()
    return _row(row) if row else None


def by_id(scope: WorkspaceScope, capture_id: uuid.UUID) -> CaptureRow | None:
    """One capture by id, deleted or not, or None when this workspace has no such row.

    **Deliberately not filtered on ``deleted_at``**, unlike :func:`live_for_blob`. The caller
    here is a worker resuming from a queued id, and "this capture does not exist" and "the user
    deleted this capture" are two different facts that lead to two different run outcomes: one is
    a fault worth reporting and the other is the deletion path working. Filtering here would
    collapse them into a lookup miss, and the run would be recorded as failed and retried against
    content somebody asked to have removed. ``deleted_at`` is on the row this returns, so the
    decision is made where the outcomes differ.
    """
    row = scope.connection.execute(
        f"select {_COLUMNS} from capture where workspace_id = %s and capture_id = %s",
        (scope.workspace_id, capture_id),
    ).fetchone()
    return _row(row) if row else None


def insert(
    scope: WorkspaceScope, blob_id: BlobId, *, device_id: str | None, started_at: str | None
) -> CaptureRow:
    """Register that this workspace holds these bytes."""
    row = scope.connection.execute(
        "insert into capture (workspace_id, blob_sha256, device_id, started_at) "
        "values (%s, %s, %s, %s) returning capture_id",
        (scope.workspace_id, blob_id.digest, device_id, started_at),
    ).fetchone()
    assert row is not None
    return CaptureRow(
        capture_id=row["capture_id"],
        blob_id=blob_id,
        device_id=device_id,
        started_at=started_at,
        deleted_at=None,
    )


def with_context(scope: WorkspaceScope) -> list[dict[str, Any]]:
    """Every live capture with its clock anchor and probe, ordered by wall clock.

    Captures with no timestamp sort last and deterministically, by capture id, so a scene
    grouping run over the same corpus produces the same groups every time.
    """
    rows = scope.connection.execute(
        "select c.capture_id, c.blob_sha256, c.started_at, t.probe_json, "
        "       a.utc_instant, a.source, a.uncertainty_ms "
        "from capture c "
        "join media_track t on t.blob_sha256 = c.blob_sha256 and t.track_key = 'img' "
        "left join clock_anchor a on a.track_id = t.track_id "
        "where c.workspace_id = %s and c.deleted_at is null "
        "order by coalesce(a.utc_instant, 'infinity'::timestamptz), c.capture_id",
        (scope.workspace_id,),
    ).fetchall()
    return [
        {
            "capture_id": row["capture_id"],
            "blob_id": BlobId(bytes(row["blob_sha256"])),
            "utc_instant": _iso(row["utc_instant"]),
            "clock_source": row["source"],
            "uncertainty_ms": row["uncertainty_ms"],
            "gps": (row["probe_json"] or {}).get("gps"),
        }
        for row in rows
    ]

"""Objects computed from other objects, each recording exactly what it was computed from.

``depends_on`` and ``dep_index`` are not bookkeeping. A generated summary that does not record
the ids it was conditioned on cannot be invalidated when one of them is deleted, and a name
survives its own deletion inside a caption.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from psycopg.types.json import Jsonb

from orimera.ingest.spine.scope import WorkspaceScope

__all__ = ["upsert"]


def upsert(
    scope: WorkspaceScope,
    *,
    derived_id: uuid.UUID,
    kind: str,
    depends_on: list[dict[str, Any]],
    dep_index: list[str],
    source_ids: Sequence[uuid.UUID],
    payload: dict[str, Any],
) -> bool:
    """Write a derived object. Returns False when this ``derived_id`` was already written."""
    cursor = scope.connection.execute(
        "insert into derived_artifact (derived_id, workspace_id, kind, depends_on, "
        "dep_index, source_ids, payload, stale) "
        "values (%s, %s, %s, %s, %s::text[], %s::uuid[], %s, false) "
        "on conflict (derived_id) do nothing",
        (
            derived_id,
            scope.workspace_id,
            kind,
            Jsonb(depends_on),
            list(dep_index),
            list(source_ids),
            Jsonb(payload),
        ),
    )
    return cursor.rowcount > 0

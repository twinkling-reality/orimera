"""What a detector saw in one scene, at one address, under one identity key.

Invariant 3 and invariant 4 meet in this table, and the enforcement is the column list itself:
there is no column for a name, and nothing writable from here can create an entity or a link. A
scene-local occurrence is not a persistent entity, and promotion is a separate, user-driven
event in ``exulanica.identity``.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from psycopg.types.json import Jsonb

from exulanica.db.guards import terminal_if_tombstoned
from exulanica.ingest.spine.scope import WorkspaceScope
from exulanica.ingest.spine.tombstones import _multirange

__all__ = ["insert"]


def insert(
    scope: WorkspaceScope,
    *,
    capture_id: uuid.UUID,
    occurrence_class: str,
    primary_span_id: uuid.UUID,
    span_ids: Sequence[uuid.UUID],
    presence: Sequence[tuple[int, int]],
    produced_by_run: uuid.UUID,
    detector_version: str,
    identity_key: bytes,
    emit_key: str,
    quality: dict[str, Any] | None = None,
) -> uuid.UUID | None:
    """Write a scene-local occurrence. Returns None when this ``emit_key`` was already emitted.

    ``presence`` is the union of the cited span intervals, written with the same half-open bound
    the tombstone guard matches against; see :mod:`exulanica.ingest.spine.tombstones`.
    """
    with terminal_if_tombstoned():
        row = scope.connection.execute(
            "insert into occurrence (workspace_id, capture_id, class, primary_span_id, "
            "span_ids, presence, produced_by_run, detector_version, quality, identity_key, "
            "emit_key) values (%s, %s, %s, %s, %s::uuid[], %s::int8multirange, %s, %s, %s, "
            "%s, %s) on conflict (workspace_id, emit_key) do nothing returning occurrence_id",
            (
                scope.workspace_id,
                capture_id,
                occurrence_class,
                primary_span_id,
                list(span_ids),
                _multirange(presence),
                produced_by_run,
                detector_version,
                Jsonb(quality) if quality else None,
                identity_key,
                emit_key,
            ),
        ).fetchone()
    return row["occurrence_id"] if row is not None else None

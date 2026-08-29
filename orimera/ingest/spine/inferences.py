"""Which inference claims survived the write guards, for the code that votes on them.

A read, and only ever a read. ``orimera.epistemics.assertions`` is the one place an assertion is
written, because the support-span rule, the allows-kind check and the tombstone translation are
invariants and two implementations of them are two places to drift. That argument is about
writing. This is a scene-grouping question shaped by capture ids, asked by
``orimera.ingest.scenes`` and by nothing else, so it stays in the package that asks it rather
than widening a module three layers of callers share.

Reading back from ``assertion`` rather than from the vision artifact is the whole point: a claim
the guards refused at write time is not in this result, so it cannot vote.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from orimera.ingest.spine.scope import WorkspaceScope

__all__ = ["place_is_for_captures"]


def place_is_for_captures(
    scope: WorkspaceScope, capture_ids: Sequence[uuid.UUID]
) -> list[dict[str, Any]]:
    """Active ``place_is`` inference assertions for these captures, with their support."""
    if not capture_ids:
        return []
    rows = scope.connection.execute(
        "select a.assertion_id, a.object_value, a.subject_ref, a.support_span_ids "
        "from assertion a join predicate p on p.predicate_id = a.predicate_id "
        "where a.workspace_id = %s and p.key = 'place_is' and a.kind = 'inference' "
        "and a.status = 'active' and a.subject_ref->>'id' = any(%s::text[]) "
        "order by a.assertion_id",
        (scope.workspace_id, [str(c) for c in capture_ids]),
    ).fetchall()
    return [
        {
            "assertion_id": row["assertion_id"],
            "label": row["object_value"],
            "capture_id": uuid.UUID(row["subject_ref"]["id"]),
            "support_span_ids": list(row["support_span_ids"]),
        }
        for row in rows
    ]

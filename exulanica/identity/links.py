"""What has been decided about this detection, in what state, and by whom?

``entity_link`` is where a decision is recorded, which is why nothing here repoints an existing
link at a different entity: editing one to say something the user never said would lose the fact
that they once said the other thing. A change of mind is a new row and a state change on the old.

**A confirmed link is a human decision, structurally.** ``confirmed_needs_a_human`` (migration
0001) requires ``decided_by is not null and method = 'user_confirm'``, so no argument combination
reachable from a model can produce one.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from exulanica.identity.repository import IdentityRepository

__all__ = ["LinkRow", "Links"]


@dataclass(frozen=True, slots=True)
class LinkRow:
    link_id: uuid.UUID
    occurrence_id: uuid.UUID
    entity_id: uuid.UUID
    state: str
    method: str
    basis_digest: bytes
    decided_by: uuid.UUID | None


class Links:
    """Reads and writes over ``entity_link``."""

    def __init__(self, repository: IdentityRepository) -> None:
        self._repository = repository

    def insert(
        self,
        *,
        occurrence_id: uuid.UUID,
        entity_id: uuid.UUID,
        state: str,
        method: str,
        basis_digest: bytes,
        decided_by: uuid.UUID | None = None,
        score: float | None = None,
    ) -> uuid.UUID:
        """Write a link. ``confirmed`` is refused by CHECK unless a human decided it."""
        row = self._repository.connection.execute(
            "insert into entity_link (workspace_id, occurrence_id, entity_id, state, method, "
            "score, basis_digest, decided_by, decided_at) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, "
            "case when %s::uuid is null then null else now() end) returning link_id",
            (
                self._repository.workspace_id,
                occurrence_id,
                entity_id,
                state,
                method,
                score,
                basis_digest,
                decided_by,
                decided_by,
            ),
        ).fetchone()
        assert row is not None
        return row["link_id"]

    def for_occurrence(
        self, occurrence_id: uuid.UUID, *, states: Sequence[str] = ("confirmed",)
    ) -> LinkRow | None:
        row = self._repository.connection.execute(
            "select link_id, occurrence_id, entity_id, state, method, basis_digest, decided_by "
            "from entity_link where workspace_id = %s and occurrence_id = %s "
            "and state = any(%s::link_state[]) order by created_at desc limit 1",
            (self._repository.workspace_id, occurrence_id, list(states)),
        ).fetchone()
        return None if row is None else _row(row)

    def of_entity(
        self, entity_id: uuid.UUID, *, states: Sequence[str] = ("confirmed",)
    ) -> list[LinkRow]:
        rows = self._repository.connection.execute(
            "select link_id, occurrence_id, entity_id, state, method, basis_digest, decided_by "
            "from entity_link where workspace_id = %s and entity_id = %s "
            "and state = any(%s::link_state[]) order by link_id",
            (self._repository.workspace_id, entity_id, list(states)),
        ).fetchall()
        return [_row(row) for row in rows]

    def set_state(self, link_id: uuid.UUID, state: str) -> None:
        self._repository.connection.execute(
            "update entity_link set state = %s where workspace_id = %s and link_id = %s",
            (state, self._repository.workspace_id, link_id),
        )


def _row(row: Mapping[str, Any]) -> LinkRow:
    return LinkRow(
        link_id=row["link_id"],
        occurrence_id=row["occurrence_id"],
        entity_id=row["entity_id"],
        state=row["state"],
        method=row["method"],
        basis_digest=bytes(row["basis_digest"]),
        decided_by=row["decided_by"],
    )

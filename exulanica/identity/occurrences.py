"""Which detection is this, and which detections is this person confirmed to be?

An occurrence is scene-local and carries no name, because ``occurrence`` has no column that could
hold one: ``display_name`` is on ``entity`` and nowhere else. That is why there is no ``set_name``
here to match the one on :mod:`orimera.identity.entities`. A detection that could carry a name
would make a detector's output indistinguishable from what the account holder said.

:attr:`OccurrenceRow.identity_key` is derived from the evidence rather than from this row's own
id, which is what makes rejection memory survive a detector re-run. See
:func:`orimera.identity.keys.occurrence_identity_key` for the derivation.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from orimera.identity.repository import IdentityRepository

__all__ = ["OccurrenceRow", "Occurrences"]


@dataclass(frozen=True, slots=True)
class OccurrenceRow:
    occurrence_id: uuid.UUID
    capture_id: uuid.UUID
    occurrence_class: str
    primary_span_id: uuid.UUID
    span_ids: tuple[uuid.UUID, ...]
    identity_key: bytes


class Occurrences:
    """Reads over ``occurrence``. Nothing here writes one: ingest does that."""

    def __init__(self, repository: IdentityRepository) -> None:
        self._repository = repository

    def by_id(self, occurrence_id: uuid.UUID) -> OccurrenceRow | None:
        row = self._repository.connection.execute(
            "select occurrence_id, capture_id, class, primary_span_id, span_ids, identity_key "
            "from occurrence where workspace_id = %s and occurrence_id = %s",
            (self._repository.workspace_id, occurrence_id),
        ).fetchone()
        return None if row is None else _row(row)

    def of_entity(self, entity_id: uuid.UUID) -> list[OccurrenceRow]:
        """Every occurrence confirmed to be this entity, in insertion order.

        Confirmed only. An ``auto_provisional`` link may drive layout and filtering and may
        never support a factual claim, so a caller asking "where has this person been" gets the
        confirmed set and has to ask separately for the guesses.
        """
        rows = self._repository.connection.execute(
            "select o.occurrence_id, o.capture_id, o.class, o.primary_span_id, o.span_ids, "
            "o.identity_key from occurrence o "
            "join entity_link l on l.occurrence_id = o.occurrence_id "
            "where o.workspace_id = %s and l.entity_id = %s and l.state = 'confirmed' "
            "order by o.occurrence_id",
            (self._repository.workspace_id, entity_id),
        ).fetchall()
        return [_row(row) for row in rows]


def _row(row: Mapping[str, Any]) -> OccurrenceRow:
    return OccurrenceRow(
        occurrence_id=row["occurrence_id"],
        capture_id=row["capture_id"],
        occurrence_class=row["class"],
        primary_span_id=row["primary_span_id"],
        span_ids=tuple(row["span_ids"]),
        identity_key=bytes(row["identity_key"]),
    )

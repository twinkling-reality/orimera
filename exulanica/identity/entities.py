"""What is one person record, and which record represents it now?

**This module cannot write a name, and the database is what stops it.**
:meth:`Entities.set_name_cache` exists, and ``tg_entity_name_is_user_stated`` (migration 0002)
refuses it unless an active ``kind='user'`` assertion under a naming predicate already says so.
So the only route to a name is through :func:`orimera.identity.decisions.name_occurrence` or
:func:`orimera.identity.naming.rename_entity`, both of which write the claim first, and a caller
reaching for this method directly gets a refusal rather than a name. The method is spelled
``set_name_cache`` rather than ``set_display_name`` for that reason: ``entity.display_name`` is a
cache of a claim, and a call site that writes only the cache should look wrong on sight.

**A merge is an alias redirect.** :meth:`Entities.set_merged_into` writes one column and rewrites
no links, so :meth:`Entities.resolve` is what every reader of a link has to go through.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from orimera.identity.repository import IdentityRepository

__all__ = ["Entities", "EntityRow"]


@dataclass(frozen=True, slots=True)
class EntityRow:
    entity_id: uuid.UUID
    entity_class: str
    display_name: str | None
    merged_into: uuid.UUID | None
    deleted_at: Any


class Entities:
    """Reads and writes over ``entity``."""

    def __init__(self, repository: IdentityRepository) -> None:
        self._repository = repository

    def create(self, *, entity_class: str) -> uuid.UUID:
        """A new entity, unnamed. There is no argument for a name and that is deliberate."""
        row = self._repository.connection.execute(
            "insert into entity (workspace_id, class) values (%s, %s) returning entity_id",
            (self._repository.workspace_id, entity_class),
        ).fetchone()
        assert row is not None
        return row["entity_id"]

    def by_id(self, entity_id: uuid.UUID) -> EntityRow | None:
        row = self._repository.connection.execute(
            "select entity_id, class, display_name, merged_into, deleted_at from entity "
            "where workspace_id = %s and entity_id = %s",
            (self._repository.workspace_id, entity_id),
        ).fetchone()
        return None if row is None else _row(row)

    def resolve(self, entity_id: uuid.UUID) -> uuid.UUID:
        """Follow ``merged_into`` to the entity that now represents this one.

        A merge is an alias redirect rather than a rewrite of every link, so a link written
        before the merge still names the old entity and still has to resolve. The walk is
        bounded: a cycle would be a bug in the merge path rather than something to survive, so
        it raises rather than looping.
        """
        seen: list[uuid.UUID] = []
        current = entity_id
        while True:
            row = self._repository.connection.execute(
                "select merged_into from entity where workspace_id = %s and entity_id = %s",
                (self._repository.workspace_id, current),
            ).fetchone()
            if row is None or row["merged_into"] is None:
                return current
            if current in seen:
                raise RuntimeError(f"merged_into cycle through {current}: {seen}")
            seen.append(current)
            current = row["merged_into"]

    def set_name_cache(self, entity_id: uuid.UUID, display_name: str | None) -> None:
        """Set the cached name. Refused by trigger unless an active user assertion says so.

        ``None`` is a real argument rather than a way of clearing a mistake: it is how the undo
        of a first rename returns an entity to unnamed, which is where it was.
        """
        self._repository.connection.execute(
            "update entity set display_name = %s where workspace_id = %s and entity_id = %s",
            (display_name, self._repository.workspace_id, entity_id),
        )

    def set_merged_into(self, entity_id: uuid.UUID, target: uuid.UUID | None) -> None:
        self._repository.connection.execute(
            "update entity set merged_into = %s where workspace_id = %s and entity_id = %s",
            (target, self._repository.workspace_id, entity_id),
        )


def _row(row: Mapping[str, Any]) -> EntityRow:
    return EntityRow(
        entity_id=row["entity_id"],
        entity_class=row["class"],
        display_name=row["display_name"],
        merged_into=row["merged_into"],
        deleted_at=row["deleted_at"],
    )

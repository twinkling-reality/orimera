"""What was decided, in what order, and does the record say enough to undo it?

``identity_event`` is the ledger, and the payload is the reason undo is exact rather than
approximate. A merge that recorded only "a and b became c" could be undone approximately; a merge
that records the exact link set at merge time can be undone to the state that existed.

:meth:`Events.undo_of` is what makes undoing twice a refusal rather than a second no-op. The
handlers in :mod:`exulanica.identity.undo` read a payload and nothing else, so an event whose undo
already happened would otherwise be applied again against a state it does not describe.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from psycopg.types.json import Jsonb

if TYPE_CHECKING:
    from exulanica.identity.repository import IdentityRepository

__all__ = ["Events"]


class Events:
    """Reads and writes over ``identity_event``. Nothing here edits one."""

    def __init__(self, repository: IdentityRepository) -> None:
        self._repository = repository

    def record(
        self,
        event_type: str,
        *,
        actor: uuid.UUID,
        payload: dict[str, Any],
        undoes: uuid.UUID | None = None,
    ) -> uuid.UUID:
        """Append one identity event. The payload is what makes undo exact."""
        row = self._repository.connection.execute(
            "insert into identity_event (workspace_id, type, actor, payload, undoes) "
            "values (%s, %s, %s, %s, %s) returning event_id",
            (self._repository.workspace_id, event_type, actor, Jsonb(payload), undoes),
        ).fetchone()
        assert row is not None
        return row["event_id"]

    def by_id(self, event_id: uuid.UUID) -> dict[str, Any] | None:
        return self._repository.connection.execute(
            "select event_id, type, actor, payload, undoes, created_at from identity_event "
            "where workspace_id = %s and event_id = %s",
            (self._repository.workspace_id, event_id),
        ).fetchone()

    def undo_of(self, event_id: uuid.UUID) -> uuid.UUID | None:
        """The event that undid this one, if any. Undoing twice is a bug, not a no-op."""
        row = self._repository.connection.execute(
            "select event_id from identity_event where workspace_id = %s and undoes = %s "
            "limit 1",
            (self._repository.workspace_id, event_id),
        ).fetchone()
        return None if row is None else row["event_id"]

    def recent(self, *, limit: int = 50) -> list[dict[str, Any]]:
        return self._repository.connection.execute(
            "select event_id, type, actor, payload, undoes, created_at from identity_event "
            "where workspace_id = %s order by created_at desc, event_id desc limit %s",
            (self._repository.workspace_id, limit),
        ).fetchall()

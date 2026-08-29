"""Were these two records pulled apart by a person, so that a merge of them must be refused?

A split is the one identity decision that says something about a PAIR of entities rather than
about a detection, and ``never_same`` is where it is written down. Without the row, undoing a
split would be a merge away, and the merge would look like an ordinary one rather than the
reversal of something the account holder decided.

**:meth:`NeverSamePairs.forget` is the only DELETE in the identity repository**, and it is here
rather than folded into :mod:`orimera.identity.entities` so that the one place a row is destroyed
is visible from the module list. Only the undo of the split that wrote the row may call it: the
row is a constraint the split created, so removing it belongs to removing the split and to
nothing else.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from orimera.identity.repository import IdentityRepository

__all__ = ["NeverSamePairs"]


class NeverSamePairs:
    """Reads and writes over ``never_same``."""

    def __init__(self, repository: IdentityRepository) -> None:
        self._repository = repository

    def record(
        self, a: uuid.UUID, b: uuid.UUID, *, created_by_event: uuid.UUID | None = None
    ) -> None:
        """These two are not the same person. Stored once, with ``entity_a < entity_b``."""
        low, high = sorted((a, b))
        self._repository.connection.execute(
            "insert into never_same (workspace_id, entity_a, entity_b, created_by_event) "
            "values (%s, %s, %s, %s) on conflict (workspace_id, entity_a, entity_b) do nothing",
            (self._repository.workspace_id, low, high, created_by_event),
        )

    def holds(self, a: uuid.UUID, b: uuid.UUID) -> bool:
        low, high = sorted((a, b))
        row = self._repository.connection.execute(
            "select 1 from never_same where workspace_id = %s and entity_a = %s and entity_b = %s",
            (self._repository.workspace_id, low, high),
        ).fetchone()
        return row is not None

    def forget(self, a: uuid.UUID, b: uuid.UUID) -> int:
        """Only an undo of the split that wrote it may do this."""
        low, high = sorted((a, b))
        cursor = self._repository.connection.execute(
            "delete from never_same where workspace_id = %s and entity_a = %s and entity_b = %s",
            (self._repository.workspace_id, low, high),
        )
        return cursor.rowcount

"""What every identity decision shares: what can go wrong, and what a subject must be.

Split out of :mod:`orimera.identity.decisions` when that module passed 700 lines and was holding
three responsibilities: the vocabulary of a decision, the decisions themselves, and their
inverses. This is the first of the three, and it is the one both of the others import.

**The errors are the interesting part.** :class:`UnknownSubject` is deliberately one error for
"does not exist" and "belongs to somebody else", and every route that raises it answers 404. Two
errors would make the identity surface an existence oracle, which is the same rule the query
path states: nonexistent ids and ids belonging to another tenant return the identical code.

Nothing here writes. The two ``require_`` functions read one row and raise if it is not there,
so that a decision can be written as though its subjects exist.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from orimera.errors import OrimeraError
from orimera.identity.repository import EntityRow, IdentityRepository, OccurrenceRow

__all__ = [
    "ENTITY_ENTITY",
    "OCCURRENCE_ENTITY",
    "AlreadyIdentified",
    "IdentityError",
    "NamedPerson",
    "NeverSame",
    "NotUndoable",
    "UnknownSubject",
    "dependency_keys",
    "require_entity",
    "require_occurrence",
]

#: The scope every occurrence-to-entity rejection is filed under. The other scope,
#: ``entity_entity``, records a refused merge.
OCCURRENCE_ENTITY: str = "occurrence_entity"
ENTITY_ENTITY: str = "entity_entity"

#: The only method a confirmed link may carry, per ``confirmed_needs_a_human``.
_USER_CONFIRM = "user_confirm"


class IdentityError(OrimeraError):
    """A user decision cannot be applied as asked."""


class UnknownSubject(IdentityError):
    """An occurrence or entity that is not in this workspace.

    Deliberately one error for "does not exist" and "belongs to someone else", because
    distinguishing them makes the surface an existence oracle. The architecture states the same
    rule for the query path: nonexistent ids and ids belonging to another tenant return the
    identical code.
    """


class AlreadyIdentified(IdentityError):
    """This occurrence is already confirmed to be somebody.

    One confirmed link per occurrence is a partial unique index, not a convention. A second
    identity for the same person in the same photograph is not a richer record, it is two
    answers to a question that has one.
    """


class NeverSame(IdentityError):
    """A split said these two are different people, so they may not be merged."""


class NotUndoable(IdentityError):
    """This event cannot be undone, and the message says why rather than doing nothing."""


@dataclass(frozen=True, slots=True)
class NamedPerson:
    """What :func:`name_occurrence` created, so a caller need not re-read it."""

    entity_id: uuid.UUID
    link_id: uuid.UUID
    assertion_id: uuid.UUID
    event_ids: tuple[uuid.UUID, ...]


def dependency_keys(**subjects: Any) -> list[str]:
    """The ``dep_index`` strings for the things a decision touched.

    ``derived_artifact.dep_index`` is the flattened ``'kind:<uuid>'`` form with a GIN index over
    it, so invalidation is a query rather than a list somebody has to remember to update.
    """
    keys: list[str] = []
    for kind, value in subjects.items():
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple, set)) else [value]
        keys.extend(f"{kind}:{item}" for item in values)
    return keys


def require_occurrence(
    repository: IdentityRepository, occurrence_id: uuid.UUID
) -> OccurrenceRow:
    occurrence = repository.occurrence(occurrence_id)
    if occurrence is None:
        raise UnknownSubject(f"no occurrence {occurrence_id} in this workspace")
    return occurrence


def require_entity(repository: IdentityRepository, entity_id: uuid.UUID) -> EntityRow:
    entity = repository.entity(entity_id)
    if entity is None or entity.deleted_at is not None:
        raise UnknownSubject(f"no entity {entity_id} in this workspace")
    return entity

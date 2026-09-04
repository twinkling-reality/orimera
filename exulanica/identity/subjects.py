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

from orimera.errors import OrimeraError
from orimera.identity.entities import EntityRow
from orimera.identity.occurrences import OccurrenceRow
from orimera.identity.repository import IdentityRepository

__all__ = [
    "ENTITY_ENTITY",
    "OCCURRENCE_ENTITY",
    "AlreadyIdentified",
    "IdentityError",
    "NamedPerson",
    "NeverSame",
    "NotUndoable",
    "UnknownSubject",
    "require_entity",
    "require_occurrence",
]

#: The scope every occurrence-to-entity rejection is filed under. Every
#: :meth:`orimera.identity.rejections.Rejections.record` call in this package passes it.
OCCURRENCE_ENTITY: str = "occurrence_entity"

#: The other value ``identity_rejection.scope`` may hold, per the CHECK at 0001_spine.sql:602.
#: Nothing writes it and this is not an omission: a refused merge is recorded in ``never_same``,
#: which a later merge is checked against, and a rejection row would record the refusal without
#: constraining anything. Kept as the name of the value the column permits, so the constant and
#: the constraint do not drift apart.
ENTITY_ENTITY: str = "entity_entity"


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


def require_occurrence(
    repository: IdentityRepository, occurrence_id: uuid.UUID
) -> OccurrenceRow:
    occurrence = repository.occurrences.by_id(occurrence_id)
    if occurrence is None:
        raise UnknownSubject(f"no occurrence {occurrence_id} in this workspace")
    return occurrence


def require_entity(repository: IdentityRepository, entity_id: uuid.UUID) -> EntityRow:
    entity = repository.entities.by_id(entity_id)
    if entity is None or entity.deleted_at is not None:
        raise UnknownSubject(f"no entity {entity_id} in this workspace")
    return entity

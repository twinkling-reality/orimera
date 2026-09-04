"""Correcting who somebody is. Renaming an entity the account holder already named.

**A rename is two writes and the second one is not optional.** Migration 0006 makes ``name_is``
supersede: inserting a new active naming assertion retires the previous one inside the insert
statement. Migration 0002's ``tg_entity_name_follows_its_assertion`` then fires on that
retirement and NULLS ``entity.display_name``, because at that instant the retired value still
equals the displayed one and the replacement row does not exist yet. 0006's trigger is BEFORE
INSERT, so the ``not exists`` guard that would have seen the replacement cannot: the row whose
insert caused all this has not been inserted.

Measured against the schema as it stands:

    named Julie                                  display_name = 'Julie'
    ONE WRITE: insert the new naming assertion   display_name = None
    entities.set_name_cache('Julie R.')          display_name = 'Julie R.'

Three consequences the code below depends on, each measured rather than reasoned:

*   The cache write is UNCONDITIONAL, including when the new name equals the old one. The
    supersession fires on a no-op rename too, because the emit key is new, so a route that
    skipped the cache write because the string had not changed would blank the name.
*   Both writes are in one transaction. Outside one, the NULL is a real state another reader can
    observe, and what they would see is a person losing their name for the width of a statement.
*   The emit key must be new on every rename. Reusing the one ``name_occurrence`` wrote hits both
    ``on conflict do nothing`` and 0006's own emit key guard, so nothing is written, nothing is
    retired, and the rename silently succeeds having done nothing.

WHY SUPERSEDE RATHER THAN WRITE A SECOND NAME. Because 0002 already decided it: "History is
corrected by writing a new row that supersedes this one, or by a retraction, both of which leave
the original readable." Two active naming assertions would be an entity with two current names
and no rule about which is shown, which is the defect R16 closed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import psycopg

from orimera.epistemics.assertions import AssertionWriter
from orimera.identity.repository import IdentityRepository

__all__ = ["ConcurrentRename", "RenamedEntity", "rename_entity"]

_NAME_PREDICATE = "name_is"


class ConcurrentRename(Exception):
    """Two renames of one entity raced and the second was refused rather than merged.

    0006's partial unique index blocks the second inserter until the first commits and then
    refuses it. Refusing is right: the alternative is one of two names the user typed winning by
    timing, with no record that the other was ever said.
    """


@dataclass(frozen=True, slots=True)
class RenamedEntity:
    """What a rename produced, including the claim it retired."""

    entity_id: uuid.UUID
    assertion_id: uuid.UUID
    #: The naming assertion this one superseded, or None when the entity had no active name.
    #: The second is a real case: a name retracted earlier leaves an entity nobody has renamed.
    superseded: uuid.UUID | None
    event_id: uuid.UUID


def rename_entity(
    repository: IdentityRepository,
    assertions: AssertionWriter,
    *,
    entity_id: uuid.UUID,
    display_name: str,
    actor: uuid.UUID,
) -> RenamedEntity:
    """The account holder corrects a name they gave. One transaction, two writes."""
    target = repository.entities.resolve(entity_id)
    entity = repository.entities.by_id(target)
    if entity is None:
        raise LookupError(f"no entity {entity_id}")

    previous = repository.connection.execute(
        "select a.assertion_id from assertion a "
        "join predicate p on p.predicate_id = a.predicate_id "
        "where a.workspace_id = %s and p.key = %s and a.status = 'active' "
        "  and a.subject_ref ->> 'type' = 'entity' and a.subject_ref ->> 'id' = %s",
        (repository.workspace_id, _NAME_PREDICATE, str(target)),
    ).fetchone()

    with repository.transaction():
        try:
            assertion_id = assertions.insert(
                kind="user",
                predicate_key=_NAME_PREDICATE,
                subject_ref={"type": "entity", "id": str(target)},
                object_value=display_name,
                support_span_ids=[],
                stated_by_user=actor,
                # A new key on every rename. The one `name_occurrence` wrote is
                # `identity:name:{entity_id}`, and reusing it would be deduplicated into silence.
                emit_key=f"identity:rename:{target}:{uuid.uuid4()}",
            )
        except psycopg.errors.UniqueViolation as exc:
            raise ConcurrentRename(
                f"entity {target} was renamed by another request while this one was in flight. "
                "Read the current name and decide again rather than overwriting a decision "
                "somebody just made."
            ) from exc
        assert assertion_id is not None, "a fresh emit_key cannot collide"

        # NOT optional and NOT conditional. See the module docstring: the insert above has
        # already nulled the column via the retirement of the claim it superseded.
        repository.entities.set_name_cache(target, display_name)

        event_id = repository.events.record(
            "entity_renamed",
            actor=actor,
            payload={
                "entity_id": str(target),
                "display_name": display_name,
                "assertion_id": str(assertion_id),
                "superseded": str(previous["assertion_id"]) if previous else None,
            },
        )
        repository.recomputation.mark_stale(entity=target)

    return RenamedEntity(
        entity_id=target,
        assertion_id=assertion_id,
        superseded=previous["assertion_id"] if previous else None,
        event_id=event_id,
    )

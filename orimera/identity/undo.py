"""Reversing one identity decision, from what its event recorded rather than from a guess.

Split out of :mod:`orimera.identity.decisions` for the reason that module names: an inverse is
not the same responsibility as the thing it inverts, and holding both meant one file carrying a
handler table, six handlers and the six decisions they undo.

**A handler table rather than a branch.** :data:`UNDO_HANDLERS` maps an event type to its
inverse, and an event type absent from it is refused **by name**. A branch with a fallthrough
would do nothing and report success, which is the worst possible answer to "undo this": the user
believes their change was reversed and it was not.

**Every handler reads the event's payload and nothing else.** Not the current state, and not the
shape of the code. An undo computed from the present would be a guess about what the past was,
and it would be most confidently wrong about the oldest events.
"""

from __future__ import annotations

import uuid
from typing import Any

from orimera.epistemics.assertions import AssertionWriter
from orimera.identity.keys import USER_STATEMENT_BASIS
from orimera.identity.repository import IdentityRepository
from orimera.identity.subjects import (
    OCCURRENCE_ENTITY,
    NotUndoable,
    UnknownSubject,
    dependency_keys,
    require_occurrence,
)

__all__ = ["UNDO_HANDLERS", "undo"]


def undo(repository: IdentityRepository, *, event_id: uuid.UUID, actor: uuid.UUID) -> uuid.UUID:
    """Reverse one identity decision, from what the event recorded rather than from a guess.

    Refuses rather than approximates. An event that has already been undone, an undo itself, and
    ``entity_created`` are all refused with the reason, because each would otherwise produce a
    result that looks like an undo and is not: undoing an undo is redo, and undoing the creation
    of a person means deleting them, which is a deletion cascade with tombstones rather than a
    state change.
    """
    event = repository.event(event_id)
    if event is None:
        raise UnknownSubject(f"no identity event {event_id} in this workspace")
    if repository.undo_of(event_id) is not None:
        raise NotUndoable(f"event {event_id} has already been undone")
    if event["type"] == "event_undone":
        raise NotUndoable(
            "undoing an undo is a redo, which is a separate operation with its own semantics "
            "rather than this one applied twice"
        )

    payload = event["payload"]
    handler = UNDO_HANDLERS.get(event["type"])
    if handler is None:
        raise NotUndoable(
            f"an event of type {event['type']!r} cannot be undone. Undoing the creation of a "
            "person is a deletion, which cascades and writes tombstones, not a state change."
        )

    with repository.transaction():
        touched = handler(repository, payload, actor)
        undone = repository.record_event(
            "event_undone",
            actor=actor,
            payload={"undid": str(event_id), "type": event["type"]},
            undoes=event_id,
        )
        repository.mark_derived_stale(touched)
    return undone


def _undo_confirm(
    repository: IdentityRepository, payload: dict[str, Any], actor: uuid.UUID
) -> list[str]:
    repository.set_link_state(uuid.UUID(payload["link_id"]), "revoked")
    superseded = payload.get("superseded_proposal")
    if superseded:
        # The proposal this confirmation replaced goes back to being a proposal, which is what
        # the state was before the user answered.
        repository.set_link_state(uuid.UUID(superseded), "proposed")
    # Exactly the rejections this confirmation withdrew, by id, and not "every rejection for the
    # pair". Un-revoking by pair would revive ones that were already withdrawn before the
    # confirm, and an undo that restores more than the action removed is not an undo. The list is
    # absent on events recorded before confirming withdrew anything but the user's own no, which
    # is why it is read with a default rather than indexed.
    repository.revive_rejections(
        [uuid.UUID(value) for value in payload.get("revoked_rejections") or []]
    )
    return dependency_keys(
        entity=uuid.UUID(payload["entity_id"]), occurrence=uuid.UUID(payload["occurrence_id"])
    )


def _undo_reject(
    repository: IdentityRepository, payload: dict[str, Any], actor: uuid.UUID
) -> list[str]:
    repository.revoke_rejection(
        scope=OCCURRENCE_ENTITY,
        key_a=bytes.fromhex(payload["identity_key"]),
        key_b=uuid.UUID(payload["entity_id"]).bytes,
        basis_digest=bytes.fromhex(payload["basis_digest"]),
    )
    if payload.get("link_id"):
        repository.set_link_state(uuid.UUID(payload["link_id"]), "proposed")
    return dependency_keys(
        entity=uuid.UUID(payload["entity_id"]), occurrence=uuid.UUID(payload["occurrence_id"])
    )


def _undo_revoke(
    repository: IdentityRepository, payload: dict[str, Any], actor: uuid.UUID
) -> list[str]:
    occurrence_id = uuid.UUID(payload["occurrence_id"])
    entity_id = uuid.UUID(payload["entity_id"])
    if payload.get("remembered"):
        occurrence = require_occurrence(repository, occurrence_id)
        repository.revoke_rejection(
            scope=OCCURRENCE_ENTITY,
            key_a=occurrence.identity_key,
            key_b=entity_id.bytes,
            basis_digest=USER_STATEMENT_BASIS,
        )
    repository.set_link_state(uuid.UUID(payload["link_id"]), "confirmed")
    return dependency_keys(entity=entity_id, occurrence=occurrence_id)


def _undo_merge(
    repository: IdentityRepository, payload: dict[str, Any], actor: uuid.UUID
) -> list[str]:
    sources = [uuid.UUID(source) for source in payload["from"]]
    for source in sources:
        repository.set_merged_into(source, None)
    return dependency_keys(entity=[*sources, uuid.UUID(payload["into"])])


def _undo_split(
    repository: IdentityRepository, payload: dict[str, Any], actor: uuid.UUID
) -> list[str]:
    entity_id = uuid.UUID(payload["entity_id"])
    new_entity_id = uuid.UUID(payload["into"])
    repository.forget_never_same(entity_id, new_entity_id)
    occurrences = []
    for moved in payload["moved"]:
        repository.set_link_state(uuid.UUID(moved["link_id"]), "revoked")
        repository.set_link_state(uuid.UUID(moved["revoked_link_id"]), "confirmed")
        occurrences.append(uuid.UUID(moved["occurrence_id"]))
    return dependency_keys(entity=[entity_id, new_entity_id], occurrence=occurrences)


#: Every event type this module writes, and the inverse of each. A type absent from here is
#: refused by name rather than silently doing nothing, which is why `undo` looks it up instead
#: of branching.
def _undo_rename(
    repository: IdentityRepository, payload: dict[str, Any], actor: uuid.UUID
) -> list[str]:
    """Put back the name the rename retired, by saying it again rather than by rewriting.

    The retired assertion is not reactivated. ``tg_assertion_no_in_place_rewrite`` permits a
    status change, so it could be, and it must not be: two rows would then claim the same name at
    different times with no ordering between them, and 0006's index would refuse the second
    anyway. Instead the previous VALUE is asserted afresh, which supersedes the rename forward.
    An undo is a new decision that restores a state, not a hole in the history.

    An entity whose rename superseded nothing had no active name before, so the undo retracts
    rather than restores: it puts the entity back to unnamed, which is where it was.
    """
    from orimera.identity.naming import rename_entity

    entity_id = uuid.UUID(payload["entity_id"])
    writer = AssertionWriter(repository.connection, repository.workspace_id)
    superseded = payload.get("superseded")
    if superseded is None:
        # The entity had no active name before the rename, so the undo returns it to unnamed.
        # Retracting rather than deleting: the claim was made and the record says so.
        writer.retract(
            uuid.UUID(payload["assertion_id"]),
            retracted_by=actor,
            reason="the rename that made this claim was undone",
        )
        repository.set_display_name(entity_id, None)
        return dependency_keys(entity=entity_id)

    restored = repository.connection.execute(
        "select object_value #>> '{}' as name from assertion where assertion_id = %s",
        (uuid.UUID(superseded),),
    ).fetchone()
    if restored is not None and restored["name"]:
        rename_entity(
            repository,
            writer,
            entity_id=entity_id,
            display_name=restored["name"],
            actor=actor,
        )
    return dependency_keys(entity=entity_id)


UNDO_HANDLERS = {
    "entity_renamed": _undo_rename,
    "link_confirmed": _undo_confirm,
    "link_rejected": _undo_reject,
    "link_revoked": _undo_revoke,
    "entities_merged": _undo_merge,
    "entity_split": _undo_split,
}

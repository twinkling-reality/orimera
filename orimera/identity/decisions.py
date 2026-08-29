"""One user decision, applied as one transaction, recorded so that undo is exact.

Every function here is a thing a person did. There is no function a model can call, and that is
structural rather than a matter of discipline: ``confirmed_needs_a_human`` refuses a confirmed
link without a ``decided_by`` and ``method = 'user_confirm'``, and
``tg_entity_name_is_user_stated`` refuses a name that no active ``kind='user'`` assertion
supports. A caller that wanted to promote a guess would have to defeat the database.

**A name is not stored, it is derived.** :func:`name_occurrence` writes the naming assertion
first and sets ``entity.display_name`` second, and the second write succeeds only because the
first one exists. Retracting the assertion clears the column. The column is a cache of the
claim, never the claim itself, which is what makes "the user changed their mind" a single write
rather than a cleanup job.

**Rejection memory is keyed by evidence and by basis.** A rejection says "not this occurrence,
not this entity, not on this evidence". Keyed by ``occurrence_id`` instead, the next detector
run mints a new id for the same thing in the same photograph and the rejected proposal comes
straight back forever. Keyed without the basis, a genuinely better signal set could never ask
again, which is the opposite failure and just as bad.

**What is deliberately absent.** No function here computes, stores or compares an embedding of
any kind. Identity is established by the account holder pointing at a photograph and saying who
that is. Automatic proposal from non-biometric signals (time proximity, scene grouping, place,
co-occurrence) is the next rung and would write ``match_proposal`` rows through
:meth:`orimera.identity.repository.IdentityRepository.record_proposal`; face embeddings are a
separate decision with legal weight and open item P-1 has not been answered.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from orimera.epistemics.assertions import AssertionWriter
from orimera.errors import OrimeraError
from orimera.identity.keys import USER_STATEMENT_BASIS
from orimera.identity.repository import EntityRow, IdentityRepository, OccurrenceRow

__all__ = [
    "AlreadyIdentified",
    "IdentityError",
    "NamedPerson",
    "NeverSame",
    "NotUndoable",
    "UnknownSubject",
    "confirm_link",
    "merge_entities",
    "name_occurrence",
    "reject_link",
    "revoke_link",
    "split_entity",
    "undo",
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


def _dependency_keys(**subjects: Any) -> list[str]:
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


def _require_occurrence(
    repository: IdentityRepository, occurrence_id: uuid.UUID
) -> OccurrenceRow:
    occurrence = repository.occurrence(occurrence_id)
    if occurrence is None:
        raise UnknownSubject(f"no occurrence {occurrence_id} in this workspace")
    return occurrence


def _require_entity(repository: IdentityRepository, entity_id: uuid.UUID) -> EntityRow:
    entity = repository.entity(entity_id)
    if entity is None or entity.deleted_at is not None:
        raise UnknownSubject(f"no entity {entity_id} in this workspace")
    return entity


def name_occurrence(
    repository: IdentityRepository,
    assertions: AssertionWriter,
    *,
    occurrence_id: uuid.UUID,
    display_name: str,
    actor: uuid.UUID,
) -> NamedPerson:
    """The account holder points at somebody in a photograph and says who that is.

    This is the whole of rung one, and it is the version that needs no biometric decision: a
    person is identified because a person said so. Four rows in one transaction, in an order
    that is not interchangeable:

    1. An entity, unnamed. There is no argument for a name on ``create_entity``.
    2. A ``kind='user'`` assertion under ``name_is``, citing the occurrence's own evidence span
       and naming ``actor`` as the person who said it.
    3. ``entity.display_name``, which the trigger permits only because step 2 exists.
    4. A confirmed link from the occurrence to the entity.

    Reverse steps 2 and 3 and the database refuses the update, which is the point: there is no
    ordering of these writes in which a name lands without a statement behind it.
    """
    display_name = display_name.strip()
    if not display_name:
        raise IdentityError("a name is a thing somebody said; the empty string is not one")

    occurrence = _require_occurrence(repository, occurrence_id)
    existing = repository.link_for_occurrence(occurrence_id)
    if existing is not None:
        raise AlreadyIdentified(
            f"occurrence {occurrence_id} is already confirmed as entity {existing.entity_id}. "
            "Naming it again would create a second identity for one person in one photograph; "
            "rename that entity, or revoke the link first."
        )

    with repository.transaction():
        entity_id = repository.create_entity(entity_class=occurrence.occurrence_class)
        assertion_id = assertions.insert(
            kind="user",
            predicate_key="name_is",
            subject_ref={"type": "entity", "id": str(entity_id)},
            object_value=display_name,
            # The span the user was looking at when they said it. A user statement needs no
            # support under the schema, but a naming that cites the photograph it was made from
            # is a better record than one that cites nothing.
            support_span_ids=[occurrence.primary_span_id],
            stated_by_user=actor,
            emit_key=f"identity:name:{entity_id}",
        )
        assert assertion_id is not None, "a fresh entity id cannot collide on emit_key"
        repository.set_display_name(entity_id, display_name)
        link_id = repository.insert_link(
            occurrence_id=occurrence_id,
            entity_id=entity_id,
            state="confirmed",
            method=_USER_CONFIRM,
            basis_digest=USER_STATEMENT_BASIS,
            decided_by=actor,
        )
        created = repository.record_event(
            "entity_created",
            actor=actor,
            payload={
                "entity_id": str(entity_id),
                "class": occurrence.occurrence_class,
                "named_from_occurrence": str(occurrence_id),
                "assertion_id": str(assertion_id),
            },
        )
        confirmed = repository.record_event(
            "link_confirmed",
            actor=actor,
            payload={
                "link_id": str(link_id),
                "occurrence_id": str(occurrence_id),
                "entity_id": str(entity_id),
                "method": _USER_CONFIRM,
            },
        )
        repository.mark_derived_stale(
            _dependency_keys(entity=entity_id, occurrence=occurrence_id)
        )
    return NamedPerson(
        entity_id=entity_id,
        link_id=link_id,
        assertion_id=assertion_id,
        event_ids=(created, confirmed),
    )


def confirm_link(
    repository: IdentityRepository,
    *,
    occurrence_id: uuid.UUID,
    entity_id: uuid.UUID,
    actor: uuid.UUID,
) -> uuid.UUID:
    """The account holder says this occurrence is that person. The recurrence thesis, once.

    A previous rejection of this exact pairing is revoked rather than honoured. Rejection memory
    exists to stop the SYSTEM re-proposing something the user already refused; the user refusing
    and then changing their mind is not a re-proposal, and a memory that overruled them would be
    the product arguing with its owner about their own life.
    """
    occurrence = _require_occurrence(repository, occurrence_id)
    entity = _require_entity(repository, entity_id)
    target = repository.resolve_entity(entity.entity_id)

    existing = repository.link_for_occurrence(occurrence_id)
    if existing is not None:
        if repository.resolve_entity(existing.entity_id) == target:
            return existing.link_id
        raise AlreadyIdentified(
            f"occurrence {occurrence_id} is already confirmed as entity {existing.entity_id}, "
            f"not {target}. Revoke that link before confirming a different person."
        )

    with repository.transaction():
        # Every live no about this pair, not only the one the user themselves said. Confirming
        # is a change of mind about the PAIR, and a machine rejection left live would suppress
        # future proposals for a link the account holder has now confirmed. The ids are recorded
        # on the event so undo restores exactly these and not whatever is live at the time.
        revoked = repository.revoke_all_rejections(
            scope=OCCURRENCE_ENTITY,
            key_a=occurrence.identity_key,
            key_b=target.bytes,
        )
        proposed = repository.link_for_occurrence(
            occurrence_id, states=("proposed", "auto_provisional")
        )
        if proposed is not None:
            repository.set_link_state(proposed.link_id, "revoked")
        link_id = repository.insert_link(
            occurrence_id=occurrence_id,
            entity_id=target,
            state="confirmed",
            method=_USER_CONFIRM,
            basis_digest=USER_STATEMENT_BASIS,
            decided_by=actor,
        )
        repository.record_event(
            "link_confirmed",
            actor=actor,
            payload={
                "link_id": str(link_id),
                "occurrence_id": str(occurrence_id),
                "entity_id": str(target),
                "method": _USER_CONFIRM,
                "superseded_proposal": str(proposed.link_id) if proposed else None,
                "revoked_rejections": [str(value) for value in revoked],
            },
        )
        repository.mark_derived_stale(_dependency_keys(entity=target, occurrence=occurrence_id))
    return link_id


def reject_link(
    repository: IdentityRepository,
    *,
    occurrence_id: uuid.UUID,
    entity_id: uuid.UUID,
    actor: uuid.UUID,
    basis_digest: bytes = USER_STATEMENT_BASIS,
    basis_modalities: Sequence[str] | None = None,
) -> uuid.UUID:
    """No, that is not them. Remembered against the evidence, not against the row.

    ``basis_digest`` defaults to the user's own statement. A caller rejecting a proposal should
    pass the proposal's basis instead, so that a later proposal built from genuinely different
    signals is not silently suppressed by an answer to a different question.

    ``basis_modalities`` is what the user was SHOWN, and None means nothing: they looked at their
    own photograph and said no, unprompted. That suppresses every later proposal for the pair,
    because no machine signal outranks a person about their own life. Passing an empty list would
    suppress nothing at all and is refused by the database. The digest alone cannot carry this,
    because it covers extractor versions, so a version bump would move it and revive every
    rejection.
    """
    occurrence = _require_occurrence(repository, occurrence_id)
    entity = _require_entity(repository, entity_id)
    target = repository.resolve_entity(entity.entity_id)

    confirmed = repository.link_for_occurrence(occurrence_id)
    if confirmed is not None and repository.resolve_entity(confirmed.entity_id) == target:
        raise AlreadyIdentified(
            f"occurrence {occurrence_id} is confirmed as entity {target}. Rejecting a confirmed "
            "link is a withdrawal of something the user already said: use revoke_link."
        )

    with repository.transaction():
        proposed = repository.link_for_occurrence(
            occurrence_id, states=("proposed", "auto_provisional")
        )
        if proposed is not None and repository.resolve_entity(proposed.entity_id) == target:
            repository.set_link_state(proposed.link_id, "rejected")
        rejection_id = repository.record_rejection(
            scope=OCCURRENCE_ENTITY,
            key_a=occurrence.identity_key,
            key_b=target.bytes,
            basis_digest=basis_digest,
            rejected_by=actor,
            basis_modalities=basis_modalities,
        )
        repository.record_event(
            "link_rejected",
            actor=actor,
            payload={
                "rejection_id": str(rejection_id),
                "occurrence_id": str(occurrence_id),
                "entity_id": str(target),
                "identity_key": occurrence.identity_key.hex(),
                "basis_digest": basis_digest.hex(),
                "basis_modalities": list(basis_modalities) if basis_modalities else None,
                "link_id": str(proposed.link_id) if proposed else None,
            },
        )
        repository.mark_derived_stale(_dependency_keys(entity=target, occurrence=occurrence_id))
    return rejection_id


def revoke_link(
    repository: IdentityRepository,
    *,
    occurrence_id: uuid.UUID,
    actor: uuid.UUID,
    remember: bool = True,
) -> uuid.UUID:
    """Withdraw a confirmed link. The user was wrong, or has changed their mind.

    ``remember`` writes rejection memory as well, which is usually right: having said "that is
    not Julie after all", being asked again about the same photograph is the product not
    listening. Pass False when the revocation is bookkeeping rather than a judgement, as it is
    inside :func:`split_entity`.
    """
    occurrence = _require_occurrence(repository, occurrence_id)
    link = repository.link_for_occurrence(occurrence_id)
    if link is None:
        raise UnknownSubject(f"occurrence {occurrence_id} has no confirmed link to revoke")

    with repository.transaction():
        repository.set_link_state(link.link_id, "revoked")
        if remember:
            repository.record_rejection(
                scope=OCCURRENCE_ENTITY,
                key_a=occurrence.identity_key,
                key_b=link.entity_id.bytes,
                basis_digest=USER_STATEMENT_BASIS,
                rejected_by=actor,
            )
        event_id = repository.record_event(
            "link_revoked",
            actor=actor,
            payload={
                "link_id": str(link.link_id),
                "occurrence_id": str(occurrence_id),
                "entity_id": str(link.entity_id),
                "remembered": remember,
            },
        )
        repository.mark_derived_stale(
            _dependency_keys(entity=link.entity_id, occurrence=occurrence_id)
        )
    return event_id


def merge_entities(
    repository: IdentityRepository,
    *,
    sources: list[uuid.UUID],
    target: uuid.UUID,
    actor: uuid.UUID,
) -> uuid.UUID:
    """Two records of one person become one, without rewriting a single link.

    ``entity.merged_into`` is an alias redirect, so every link written before the merge still
    names the entity it was written against and still resolves. That is what makes undo a matter
    of clearing one column rather than replaying a link rewrite, and it is why the event payload
    records the exact link set: an undo that guessed which links belonged to which source would
    be approximate, and approximate is not a property this system offers about identity.
    """
    if target in sources:
        raise IdentityError("an entity cannot be merged into itself")
    _require_entity(repository, target)
    for source in sources:
        _require_entity(repository, source)
        if repository.is_never_same(source, target):
            raise NeverSame(
                f"entities {source} and {target} were split apart by a user decision. "
                "Merging them would silently reverse it; undo the split instead."
            )

    resolved_target = repository.resolve_entity(target)
    payload_links = {
        str(source): [str(link.link_id) for link in repository.links_of(source)]
        for source in sources
    }
    with repository.transaction():
        for source in sources:
            repository.set_merged_into(source, resolved_target)
        event_id = repository.record_event(
            "entities_merged",
            actor=actor,
            payload={
                "from": [str(source) for source in sources],
                "into": str(resolved_target),
                "links": payload_links,
            },
        )
        repository.mark_derived_stale(
            _dependency_keys(entity=[*sources, resolved_target])
        )
    return event_id


def split_entity(
    repository: IdentityRepository,
    *,
    entity_id: uuid.UUID,
    occurrence_ids: list[uuid.UUID],
    actor: uuid.UUID,
) -> uuid.UUID:
    """These occurrences are somebody else. Moves them to a new, unnamed entity.

    The new entity is unnamed on purpose. The user has said "not that person"; they have not yet
    said who this is, and inventing a name or copying the old one would be the system asserting
    something nobody told it. A ``never_same`` row records the split, so a later merge of the two
    is refused rather than quietly undoing a decision.

    The old link is revoked and a new confirmed one written, rather than the old one being
    repointed. ``entity_link`` is where a decision is recorded; editing one to say something the
    user never said would lose the fact that they once said the other thing.
    """
    if not occurrence_ids:
        raise IdentityError("a split with no occurrences moves nothing")
    _require_entity(repository, entity_id)

    links = {link.occurrence_id: link for link in repository.links_of(entity_id)}
    missing = [str(o) for o in occurrence_ids if o not in links]
    if missing:
        raise UnknownSubject(
            f"occurrences {missing} are not confirmed as entity {entity_id}, so a split cannot "
            "move them"
        )
    if len(occurrence_ids) == len(links):
        raise IdentityError(
            "a split that moves every occurrence leaves the original entity empty; that is a "
            "rename, not a split"
        )

    entity = repository.entity(entity_id)
    assert entity is not None
    with repository.transaction():
        new_entity_id = repository.create_entity(entity_class=entity.entity_class)
        moved: list[dict[str, str]] = []
        for occurrence_id in occurrence_ids:
            old = links[occurrence_id]
            repository.set_link_state(old.link_id, "revoked")
            link_id = repository.insert_link(
                occurrence_id=occurrence_id,
                entity_id=new_entity_id,
                state="confirmed",
                method=_USER_CONFIRM,
                basis_digest=USER_STATEMENT_BASIS,
                decided_by=actor,
            )
            moved.append(
                {
                    "occurrence_id": str(occurrence_id),
                    "revoked_link_id": str(old.link_id),
                    "link_id": str(link_id),
                }
            )
        event_id = repository.record_event(
            "entity_split",
            actor=actor,
            payload={
                "entity_id": str(entity_id),
                "into": str(new_entity_id),
                "moved": moved,
                "kept": [
                    str(occurrence_id)
                    for occurrence_id in links
                    if occurrence_id not in set(occurrence_ids)
                ],
            },
        )
        repository.record_never_same(entity_id, new_entity_id, created_by_event=event_id)
        repository.mark_derived_stale(
            _dependency_keys(entity=[entity_id, new_entity_id], occurrence=occurrence_ids)
        )
    return event_id


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
    handler = _UNDO_HANDLERS.get(event["type"])
    if handler is None:
        raise NotUndoable(
            f"an event of type {event['type']!r} cannot be undone. Undoing the creation of a "
            "person is a deletion, which cascades and writes tombstones, not a state change."
        )

    with repository.transaction():
        touched = handler(repository, payload)
        undone = repository.record_event(
            "event_undone",
            actor=actor,
            payload={"undid": str(event_id), "type": event["type"]},
            undoes=event_id,
        )
        repository.mark_derived_stale(touched)
    return undone


def _undo_confirm(repository: IdentityRepository, payload: dict[str, Any]) -> list[str]:
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
    return _dependency_keys(
        entity=uuid.UUID(payload["entity_id"]), occurrence=uuid.UUID(payload["occurrence_id"])
    )


def _undo_reject(repository: IdentityRepository, payload: dict[str, Any]) -> list[str]:
    repository.revoke_rejection(
        scope=OCCURRENCE_ENTITY,
        key_a=bytes.fromhex(payload["identity_key"]),
        key_b=uuid.UUID(payload["entity_id"]).bytes,
        basis_digest=bytes.fromhex(payload["basis_digest"]),
    )
    if payload.get("link_id"):
        repository.set_link_state(uuid.UUID(payload["link_id"]), "proposed")
    return _dependency_keys(
        entity=uuid.UUID(payload["entity_id"]), occurrence=uuid.UUID(payload["occurrence_id"])
    )


def _undo_revoke(repository: IdentityRepository, payload: dict[str, Any]) -> list[str]:
    occurrence_id = uuid.UUID(payload["occurrence_id"])
    entity_id = uuid.UUID(payload["entity_id"])
    if payload.get("remembered"):
        occurrence = _require_occurrence(repository, occurrence_id)
        repository.revoke_rejection(
            scope=OCCURRENCE_ENTITY,
            key_a=occurrence.identity_key,
            key_b=entity_id.bytes,
            basis_digest=USER_STATEMENT_BASIS,
        )
    repository.set_link_state(uuid.UUID(payload["link_id"]), "confirmed")
    return _dependency_keys(entity=entity_id, occurrence=occurrence_id)


def _undo_merge(repository: IdentityRepository, payload: dict[str, Any]) -> list[str]:
    sources = [uuid.UUID(source) for source in payload["from"]]
    for source in sources:
        repository.set_merged_into(source, None)
    return _dependency_keys(entity=[*sources, uuid.UUID(payload["into"])])


def _undo_split(repository: IdentityRepository, payload: dict[str, Any]) -> list[str]:
    entity_id = uuid.UUID(payload["entity_id"])
    new_entity_id = uuid.UUID(payload["into"])
    repository.forget_never_same(entity_id, new_entity_id)
    occurrences = []
    for moved in payload["moved"]:
        repository.set_link_state(uuid.UUID(moved["link_id"]), "revoked")
        repository.set_link_state(uuid.UUID(moved["revoked_link_id"]), "confirmed")
        occurrences.append(uuid.UUID(moved["occurrence_id"]))
    return _dependency_keys(entity=[entity_id, new_entity_id], occurrence=occurrences)


#: Every event type this module writes, and the inverse of each. A type absent from here is
#: refused by name rather than silently doing nothing, which is why `undo` looks it up instead
#: of branching.
_UNDO_HANDLERS = {
    "link_confirmed": _undo_confirm,
    "link_rejected": _undo_reject,
    "link_revoked": _undo_revoke,
    "entities_merged": _undo_merge,
    "entity_split": _undo_split,
}

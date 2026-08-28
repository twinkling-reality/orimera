"""Identity: naming a person, finding them again, and being allowed to change your mind.

This is the recurrence thesis at its smallest honest size. Two photographs, one person, one
account holder who says so. Everything here is rung one, user-asserted identity: nothing
computes an embedding, nothing proposes a match, and nothing needs the open biometric question
answered before it can run.

Four properties are what this file exists to pin, and each of them has a specific failure it
prevents:

*   **A name comes only from the account holder.** Not from a detector, not from a caption, not
    from a direct UPDATE. The last one is the interesting case: it is the route that bypasses
    every line of Python in this repository.
*   **A confirmed link is a human decision.** ``auto_provisional`` may drive layout; only
    ``user_confirm`` may support a claim.
*   **A rejection is durable, evidence-keyed, and revocable.** Keyed by ``occurrence_id`` it
    would evaporate on the next detector run; keyed without the basis it would gag a genuinely
    better proposal forever; deleted rather than revoked it would erase that the user ever said
    no.
*   **Every decision is an event, and the event is enough to undo it.** Not approximately.
"""

from __future__ import annotations

import copy
import uuid

import psycopg
import pytest
from orimera.epistemics.assertions import AssertionWriter
from orimera.identity import (
    AlreadyIdentified,
    IdentityRepository,
    NeverSame,
    NotUndoable,
    UnknownSubject,
    basis_digest,
    confirm_link,
    merge_entities,
    name_occurrence,
    reject_link,
    revoke_link,
    split_entity,
    undo,
)
from orimera.identity.decisions import OCCURRENCE_ENTITY
from orimera.identity.keys import USER_STATEMENT_BASIS
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.store.local import LocalContentAddressedStore

from conftest import DEFAULT_PAYLOAD, CountingVisionModel, write_photo

#: What the trigger guards raise. `raise exception ... using errcode =
#: 'integrity_constraint_violation'` is SQLSTATE 23000 exactly, and psycopg maps that to this
#: class. Note that CheckViolation (23514) is NOT a subclass of it in psycopg 3, so a CHECK
#: constraint has to be named separately rather than being caught by this.
REFUSED = psycopg.errors.IntegrityConstraintViolation
CHECK_REFUSED = psycopg.errors.CheckViolation

#: A person, located, so ingest produces a person occurrence rather than a bare assertion.
_PERSON_BOX = {"x": 0.55, "y": 0.1, "w": 0.2, "h": 0.6}


def _payload_with_a_located_person() -> dict:
    payload = copy.deepcopy(DEFAULT_PAYLOAD)
    person = next(entry for entry in payload["objects"] if entry["label"] == "person")
    person["box"] = dict(_PERSON_BOX)
    return payload


@pytest.fixture
def library(tmp_path, photo_dir, repository):
    """Two photographs, each with one located person, ingested.

    Two captures rather than one, because the whole claim is about recurrence: a person named in
    one photograph and recognised in another. One capture could not distinguish "identity works"
    from "the row is still where I left it".
    """
    store = LocalContentAddressedStore(tmp_path / "blobs")
    vision = CountingVisionModel(payload=_payload_with_a_located_person())
    pipeline = PhotoIngestPipeline(repository, store, vision=vision)
    captures = (("morning.jpg", "2026:08:27 10:00:00"), ("evening.jpg", "2026:08:27 19:30:00"))
    for name, when in captures:
        outcome = pipeline.ingest_file(write_photo(photo_dir, name, when=when))
        assert outcome.error is None, outcome.error

    identity = IdentityRepository(repository.connection, repository.workspace_id)
    assertions = AssertionWriter(repository.connection, repository.workspace_id)
    people = repository.connection.execute(
        "select occurrence_id from occurrence where class = 'person' order by occurrence_id"
    ).fetchall()
    assert len(people) == 2, people
    return Library(
        repository=repository,
        identity=identity,
        assertions=assertions,
        occurrences=[row["occurrence_id"] for row in people],
        actor=uuid.uuid4(),
    )


class Library:
    def __init__(self, *, repository, identity, assertions, occurrences, actor) -> None:
        self.repository = repository
        self.identity = identity
        self.assertions = assertions
        self.occurrences = occurrences
        self.actor = actor

    def name(self, index: int, display_name: str):
        return name_occurrence(
            self.identity,
            self.assertions,
            occurrence_id=self.occurrences[index],
            display_name=display_name,
            actor=self.actor,
        )

    def identity_key(self, index: int) -> bytes:
        occurrence = self.identity.occurrence(self.occurrences[index])
        assert occurrence is not None
        return occurrence.identity_key


# -- the thesis --------------------------------------------------------------------------


def test_a_person_named_once_is_confirmable_in_a_second_capture(library):
    """The whole recurrence claim, in the version that needs no biometrics.

    Named in one photograph, confirmed in another, and the link is queryable in both
    directions: which occurrences are this person, and which person is this occurrence.
    """
    named = library.name(0, "Julie")
    entity = library.identity.entity(named.entity_id)
    assert entity is not None
    assert entity.display_name == "Julie"
    assert entity.entity_class == "person"

    confirm_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=named.entity_id,
        actor=library.actor,
    )

    occurrences = library.identity.occurrences_of(named.entity_id)
    assert {o.occurrence_id for o in occurrences} == set(library.occurrences)
    # Two captures, not one photograph counted twice. That is the claim.
    assert len({o.capture_id for o in occurrences}) == 2

    for occurrence_id in library.occurrences:
        link = library.identity.link_for_occurrence(occurrence_id)
        assert link is not None
        assert link.entity_id == named.entity_id
        assert link.state == "confirmed"
        assert link.method == "user_confirm"
        assert link.decided_by == library.actor


def test_the_name_is_a_cache_of_an_assertion_the_user_made(library):
    """Not a column somebody set. The assertion is the claim; the column repeats it."""
    named = library.name(0, "Julie")
    row = library.repository.connection.execute(
        "select a.kind, a.object_value, a.stated_by_user, a.produced_by_run, "
        "a.support_span_ids, p.key, p.writes_a_name from assertion a "
        "join predicate p on p.predicate_id = a.predicate_id "
        "where a.assertion_id = %s",
        (named.assertion_id,),
    ).fetchone()
    assert row["kind"] == "user"
    assert row["key"] == "name_is"
    assert row["writes_a_name"] is True
    assert row["object_value"] == "Julie"
    assert row["stated_by_user"] == library.actor
    # A claim the user made was not produced by a pipeline run. Migration 0002 refuses the row
    # outright if it were, which is what closed the laundering route.
    assert row["produced_by_run"] is None
    # It cites the photograph the user was looking at.
    occurrence = library.identity.occurrence(library.occurrences[0])
    assert list(row["support_span_ids"]) == [occurrence.primary_span_id]


def test_retracting_the_statement_takes_the_name_off_the_entity(library):
    """A name that outlives the statement supporting it is the failure to prevent.

    The user says "actually that is not Julie" and the label has to stop appearing. Enforced by
    trigger rather than by a cleanup pass, so there is no window in which the two disagree.
    """
    named = library.name(0, "Julie")
    assert library.identity.entity(named.entity_id).display_name == "Julie"

    library.assertions.retract(
        named.assertion_id, retracted_by=library.actor, reason="wrong person"
    )
    assert library.identity.entity(named.entity_id).display_name is None

    retraction = library.repository.connection.execute(
        "select status from assertion where assertion_id = %s", (named.assertion_id,)
    ).fetchone()
    assert retraction["status"] == "retracted", "the claim is withdrawn, not erased"


# -- invariant 4, on the route that bypasses this package entirely -----------------------


@pytest.mark.parametrize("kind", ["inference", "capture", "external"])
def test_no_model_can_name_an_entity_by_any_route(library, kind):
    """Three ways in, all refused, none of them going through Python.

    The first two are the vocabulary guard: name_is allows only 'user'. The third is the one
    that motivated migration 0002, because it needs no assertion at all: a direct UPDATE of
    entity.display_name was ACCEPTED by the committed schema with nothing supporting it.
    """
    named = library.name(0, "Julie")
    connection = library.repository.connection
    other = library.identity.create_entity(entity_class="person")

    with pytest.raises(REFUSED, match="name_is"), connection.transaction():
        connection.execute(
            "insert into assertion (workspace_id, kind, predicate_id, subject_ref, "
            "object_value, support_span_ids, produced_by_run, external_source, emit_key) "
            "select %s, %s, predicate_id, jsonb_build_object('type','entity','id',%s::text), "
            "to_jsonb('Aunt Marjorie'::text), array[]::uuid[], null, "
            "case when %s = 'external' then '{}'::jsonb else null end, %s "
            "from predicate where key = 'name_is'",
            (library.repository.workspace_id, kind, str(other), kind, f"attack:{kind}"),
        )

    with pytest.raises(REFUSED, match="no active user assertion says so"), connection.transaction():
        connection.execute(
            "update entity set display_name = 'Aunt Marjorie' where entity_id = %s", (other,)
        )

    with pytest.raises(REFUSED, match="no active user assertion says so"), connection.transaction():
        connection.execute(
            "insert into entity (workspace_id, class, display_name) values (%s, 'person', %s)",
            (library.repository.workspace_id, "Aunt Marjorie"),
        )

    # The one that is allowed still is, so the guard is not simply refusing everything.
    assert library.identity.entity(named.entity_id).display_name == "Julie"


def test_a_link_cannot_be_confirmed_without_a_human(library):
    """`confirmed_needs_a_human`: model confidence is never user confirmation."""
    named = library.name(0, "Julie")
    connection = library.repository.connection
    for method, decided_by in (("embedding_knn", uuid.uuid4()), ("user_confirm", None)):
        refusal = pytest.raises(CHECK_REFUSED, match="confirmed_needs_a_human")
        with refusal, connection.transaction():
            connection.execute(
                "insert into entity_link (workspace_id, occurrence_id, entity_id, state, "
                "method, basis_digest, decided_by) values (%s, %s, %s, 'confirmed', %s, %s, %s)",
                (
                    library.repository.workspace_id,
                    library.occurrences[1],
                    named.entity_id,
                    method,
                    USER_STATEMENT_BASIS,
                    decided_by,
                ),
            )


def test_one_occurrence_cannot_be_two_people(library):
    """Two answers to a question that has one."""
    first = library.name(0, "Julie")
    other = library.name(1, "Leo")
    with pytest.raises(AlreadyIdentified, match="already confirmed"):
        confirm_link(
            library.identity,
            occurrence_id=library.occurrences[0],
            entity_id=other.entity_id,
            actor=library.actor,
        )
    assert library.identity.link_for_occurrence(library.occurrences[0]).entity_id == first.entity_id


# -- rejection memory --------------------------------------------------------------------


def test_a_rejection_is_durable_and_keyed_by_evidence_not_by_the_row(library):
    """The defect this design exists to avoid, reproduced as the scenario that would trigger it.

    A detector re-run mints a new ``occurrence_id`` for the same person in the same photograph.
    Keyed by that id, every rejection evaporates and the user re-answers the same question
    forever. Keyed by ``identity_key``, which is a function of the evidence address, the second
    row is recognised as the same thing.
    """
    named = library.name(0, "Julie")
    reject_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=named.entity_id,
        actor=library.actor,
    )
    key = library.identity_key(1)
    assert library.identity.is_rejected(
        scope=OCCURRENCE_ENTITY,
        key_a=key,
        key_b=named.entity_id.bytes,
        basis_digest=USER_STATEMENT_BASIS,
    )

    # A second detector version over the same photograph: a new row, the same evidence.
    original = library.identity.occurrence(library.occurrences[1])
    reborn = library.repository.insert_occurrence(
        capture_id=original.capture_id,
        occurrence_class="person",
        primary_span_id=original.primary_span_id,
        span_ids=list(original.span_ids),
        presence=[(0, 1)],
        produced_by_run=library.repository.connection.execute(
            "select run_id from pipeline_run limit 1"
        ).fetchone()["run_id"],
        detector_version="vision:99",
        identity_key=original.identity_key,
        emit_key="rerun:person:0",
    )
    assert reborn is not None and reborn != library.occurrences[1]
    assert library.identity.is_rejected(
        scope=OCCURRENCE_ENTITY,
        key_a=library.identity.occurrence(reborn).identity_key,
        key_b=named.entity_id.bytes,
        basis_digest=USER_STATEMENT_BASIS,
    ), "a re-detected occurrence must inherit the answer the user already gave"


def test_a_rejection_does_not_gag_a_proposal_built_from_different_signals(library):
    """The opposite failure, and it is just as bad.

    "Not on this evidence" is what a rejection means. A system that later has genuinely
    different signals is entitled to ask again; one that could never ask again would be unable
    to improve.
    """
    named = library.name(0, "Julie")
    reject_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=named.entity_id,
        actor=library.actor,
    )
    richer = basis_digest(["co_presence", "place"], {"scene_grouping": "2"})
    assert richer != USER_STATEMENT_BASIS
    assert not library.identity.is_rejected(
        scope=OCCURRENCE_ENTITY,
        key_a=library.identity_key(1),
        key_b=named.entity_id.bytes,
        basis_digest=richer,
    )


def test_confirming_after_a_rejection_overrules_it(library):
    """The user changing their mind is not a re-proposal, and memory must not argue back."""
    named = library.name(0, "Julie")
    reject_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=named.entity_id,
        actor=library.actor,
    )
    confirm_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=named.entity_id,
        actor=library.actor,
    )
    assert not library.identity.is_rejected(
        scope=OCCURRENCE_ENTITY,
        key_a=library.identity_key(1),
        key_b=named.entity_id.bytes,
        basis_digest=USER_STATEMENT_BASIS,
    )
    assert library.identity.link_for_occurrence(library.occurrences[1]).state == "confirmed"


def test_a_rejection_is_revoked_and_never_deleted(library):
    """A deleted rejection leaves no evidence that the user ever said no."""
    named = library.name(0, "Julie")
    reject_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=named.entity_id,
        actor=library.actor,
    )
    library.identity.revoke_rejection(
        scope=OCCURRENCE_ENTITY,
        key_a=library.identity_key(1),
        key_b=named.entity_id.bytes,
        basis_digest=USER_STATEMENT_BASIS,
    )
    row = library.repository.connection.execute(
        "select rejected_at, revoked_at from identity_rejection"
    ).fetchone()
    assert row is not None, "the row is still there"
    assert row["revoked_at"] is not None


# -- merge, split, undo ------------------------------------------------------------------


def test_merging_two_records_of_one_person_keeps_every_link_resolving(library):
    """A merge is an alias redirect, so nothing that was written before it has to be rewritten."""
    julie = library.name(0, "Julie")
    duplicate = library.name(1, "Julie (again)")

    merge_entities(
        library.identity,
        sources=[duplicate.entity_id],
        target=julie.entity_id,
        actor=library.actor,
    )
    assert library.identity.resolve_entity(duplicate.entity_id) == julie.entity_id
    # The link still names the entity it was written against, and still resolves.
    link = library.identity.link_for_occurrence(library.occurrences[1])
    assert link.entity_id == duplicate.entity_id
    assert library.identity.resolve_entity(link.entity_id) == julie.entity_id


def test_a_split_refuses_a_later_merge_of_the_two_it_separated(library):
    """`never_same` is the user's decision written down, so a merge cannot quietly reverse it."""
    julie = library.name(0, "Julie")
    confirm_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=julie.entity_id,
        actor=library.actor,
    )
    split_entity(
        library.identity,
        entity_id=julie.entity_id,
        occurrence_ids=[library.occurrences[1]],
        actor=library.actor,
    )
    moved = library.identity.link_for_occurrence(library.occurrences[1])
    assert moved.entity_id != julie.entity_id
    # The new entity is unnamed: the user said "not that person", not "this is somebody named X".
    assert library.identity.entity(moved.entity_id).display_name is None

    with pytest.raises(NeverSame, match="split apart"):
        merge_entities(
            library.identity,
            sources=[moved.entity_id],
            target=julie.entity_id,
            actor=library.actor,
        )


def test_a_split_that_moves_everything_is_refused_as_a_rename(library):
    julie = library.name(0, "Julie")
    with pytest.raises(Exception, match="rename, not a split"):
        split_entity(
            library.identity,
            entity_id=julie.entity_id,
            occurrence_ids=[library.occurrences[0]],
            actor=library.actor,
        )


@pytest.mark.parametrize("decision", ["confirm", "reject", "revoke", "merge", "split"])
def test_every_recorded_decision_can_be_undone_exactly(library, decision):
    """Undo reads the event payload rather than guessing, so it restores what was there."""
    julie = library.name(0, "Julie")
    second = library.occurrences[1]

    if decision == "confirm":
        confirm_link(
            library.identity, occurrence_id=second, entity_id=julie.entity_id, actor=library.actor
        )
        event = _latest(library, "link_confirmed")
        undo(library.identity, event_id=event, actor=library.actor)
        assert library.identity.link_for_occurrence(second) is None
    elif decision == "reject":
        reject_link(
            library.identity, occurrence_id=second, entity_id=julie.entity_id, actor=library.actor
        )
        event = _latest(library, "link_rejected")
        undo(library.identity, event_id=event, actor=library.actor)
        assert not library.identity.is_rejected(
            scope=OCCURRENCE_ENTITY,
            key_a=library.identity_key(1),
            key_b=julie.entity_id.bytes,
            basis_digest=USER_STATEMENT_BASIS,
        )
    elif decision == "revoke":
        confirm_link(
            library.identity, occurrence_id=second, entity_id=julie.entity_id, actor=library.actor
        )
        revoke_link(library.identity, occurrence_id=second, actor=library.actor)
        assert library.identity.link_for_occurrence(second) is None
        undo(library.identity, event_id=_latest(library, "link_revoked"), actor=library.actor)
        restored = library.identity.link_for_occurrence(second)
        assert restored is not None and restored.entity_id == julie.entity_id
    elif decision == "merge":
        other = library.name(1, "Leo")
        merge_entities(
            library.identity,
            sources=[other.entity_id],
            target=julie.entity_id,
            actor=library.actor,
        )
        undo(library.identity, event_id=_latest(library, "entities_merged"), actor=library.actor)
        assert library.identity.resolve_entity(other.entity_id) == other.entity_id
    else:
        confirm_link(
            library.identity, occurrence_id=second, entity_id=julie.entity_id, actor=library.actor
        )
        split_entity(
            library.identity,
            entity_id=julie.entity_id,
            occurrence_ids=[second],
            actor=library.actor,
        )
        moved = library.identity.link_for_occurrence(second).entity_id
        undo(library.identity, event_id=_latest(library, "entity_split"), actor=library.actor)
        assert library.identity.link_for_occurrence(second).entity_id == julie.entity_id
        assert not library.identity.is_never_same(julie.entity_id, moved)


def test_an_event_cannot_be_undone_twice_and_an_undo_cannot_be_undone(library):
    """Both would look like an undo and be something else."""
    julie = library.name(0, "Julie")
    confirm_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=julie.entity_id,
        actor=library.actor,
    )
    confirmed = _latest(library, "link_confirmed")
    undo(library.identity, event_id=confirmed, actor=library.actor)

    with pytest.raises(NotUndoable, match="already been undone"):
        undo(library.identity, event_id=confirmed, actor=library.actor)
    with pytest.raises(NotUndoable, match="redo"):
        undo(library.identity, event_id=_latest(library, "event_undone"), actor=library.actor)


def test_creating_a_person_is_refused_by_undo_rather_than_half_done(library):
    """Undoing the creation of a person is a deletion, and deletion cascades and tombstones."""
    library.name(0, "Julie")
    with pytest.raises(NotUndoable, match="deletion"):
        undo(library.identity, event_id=_latest(library, "entity_created"), actor=library.actor)


# -- recomputation -----------------------------------------------------------------------


def test_a_decision_marks_everything_that_depended_on_it_stale(library):
    """Otherwise a generated caption naming somebody survives that person being merged away."""
    julie = library.name(0, "Julie")
    derived_id = uuid.uuid4()
    assert library.repository.upsert_derived_artifact(
        derived_id=derived_id,
        kind="episode_summary",
        depends_on=[{"kind": "entity", "id": str(julie.entity_id)}],
        dep_index=[f"entity:{julie.entity_id}"],
        source_ids=[],
        payload={"title": "A day with Julie"},
    )
    assert not _is_stale(library, derived_id)

    confirm_link(
        library.identity,
        occurrence_id=library.occurrences[1],
        entity_id=julie.entity_id,
        actor=library.actor,
    )
    assert _is_stale(library, derived_id)


def test_a_decision_about_someone_else_leaves_unrelated_artifacts_alone(library):
    """A stale flag on everything is the same as a stale flag on nothing."""
    julie = library.name(0, "Julie")
    leo = library.name(1, "Leo")
    derived_id = uuid.uuid4()
    library.repository.upsert_derived_artifact(
        derived_id=derived_id,
        kind="episode_summary",
        depends_on=[{"kind": "entity", "id": str(leo.entity_id)}],
        dep_index=[f"entity:{leo.entity_id}"],
        source_ids=[],
        payload={"title": "A day with Leo"},
    )
    revoke_link(library.identity, occurrence_id=library.occurrences[0], actor=library.actor)
    assert not _is_stale(library, derived_id)
    assert julie.entity_id != leo.entity_id


# -- workspace scoping -------------------------------------------------------------------


def test_another_workspace_is_indistinguishable_from_nothing(library):
    """Not a different error, the same one. Otherwise the surface is an existence oracle."""
    with pytest.raises(UnknownSubject):
        confirm_link(
            library.identity,
            occurrence_id=uuid.uuid4(),
            entity_id=uuid.uuid4(),
            actor=library.actor,
        )


def _latest(library, event_type: str) -> uuid.UUID:
    row = library.repository.connection.execute(
        "select event_id from identity_event where type = %s "
        "order by created_at desc, event_id desc limit 1",
        (event_type,),
    ).fetchone()
    assert row is not None, f"no {event_type} event was recorded"
    return row["event_id"]


def _is_stale(library, derived_id: uuid.UUID) -> bool:
    row = library.repository.connection.execute(
        "select stale from derived_artifact where derived_id = %s", (derived_id,)
    ).fetchone()
    assert row is not None
    return row["stale"]

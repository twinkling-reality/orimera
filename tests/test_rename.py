"""Renaming an entity, and the trap that R16 set for it.

The API could name an occurrence and could not rename an entity. Migration 0006 makes `name_is`
supersede, which is what makes a rename one assertion rather than a retraction plus a write. It
also makes the obvious implementation blank the name, silently, and that is what most of this
file is about.
"""

from __future__ import annotations

import uuid

import psycopg
import pytest
from orimera.epistemics.assertions import AssertionWriter
from orimera.identity import (
    IdentityRepository,
    name_occurrence,
    rename_entity,
    undo,
)

pytestmark = pytest.mark.postgres


@pytest.fixture
def named(repository, photo_dir, tmp_path):
    """One ingested photograph with one person in it, named Julie."""
    import copy

    from orimera.ingest.pipeline import PhotoIngestPipeline
    from orimera.store.local import LocalContentAddressedStore

    from conftest import DEFAULT_PAYLOAD, CountingVisionModel, write_photo

    payload = copy.deepcopy(DEFAULT_PAYLOAD)
    payload["objects"] = [
        {
            "label": "person",
            "salience": "primary",
            "confidence": "high",
            "box": {"x": 0.4, "y": 0.1, "w": 0.2, "h": 0.6},
        }
    ]
    store = LocalContentAddressedStore(tmp_path / "blobs")
    pipeline = PhotoIngestPipeline(repository, store, vision=CountingVisionModel(payload=payload))
    assert pipeline.ingest_file(write_photo(photo_dir, "a.jpg")).error is None

    identity = IdentityRepository(repository.connection, repository.workspace_id)
    writer = AssertionWriter(repository.connection, repository.workspace_id)
    occurrence = repository.connection.execute(
        "select occurrence_id from occurrence where class = 'person' limit 1"
    ).fetchone()
    actor = uuid.uuid4()
    person = name_occurrence(
        identity,
        writer,
        occurrence_id=occurrence["occurrence_id"],
        display_name="Julie",
        actor=actor,
    )
    return identity, writer, person.entity_id, actor


def _display_name(identity: IdentityRepository, entity_id: uuid.UUID) -> str | None:
    entity = identity.entity(entity_id)
    assert entity is not None
    return entity.display_name


def _names(identity: IdentityRepository) -> list[tuple[str, str]]:
    return [
        (row["v"], row["status"])
        for row in identity.connection.execute(
            "select a.object_value #>> '{}' as v, a.status from assertion a "
            "join predicate p on p.predicate_id = a.predicate_id "
            "where a.workspace_id = %s and p.key = 'name_is' "
            "order by a.asserted_at, a.assertion_id",
            (identity.workspace_id,),
        ).fetchall()
    ]


def test_a_rename_supersedes_the_old_name_and_leaves_it_readable(named):
    identity, writer, entity_id, actor = named
    renamed = rename_entity(
        identity, writer, entity_id=entity_id, display_name="Julie R.", actor=actor
    )
    assert _display_name(identity, entity_id) == "Julie R."
    assert _names(identity) == [("Julie", "superseded"), ("Julie R.", "active")]
    assert renamed.superseded is not None


def test_writing_only_the_assertion_leaves_the_person_with_no_name(named):
    """The trap, asserted so nobody removes the second write believing R16 made it redundant.

    0006's supersession fires inside the INSERT, and 0002's cache trigger nulls display_name on
    that retirement because the replacement row does not exist yet: 0006's trigger is BEFORE
    INSERT, so the guard that would have seen the replacement cannot. One write is not a rename.
    """
    identity, writer, entity_id, actor = named
    writer.insert(
        kind="user",
        predicate_key="name_is",
        subject_ref={"type": "entity", "id": str(entity_id)},
        object_value="Julie R.",
        support_span_ids=[],
        stated_by_user=actor,
        emit_key=f"probe:{uuid.uuid4()}",
    )
    assert _display_name(identity, entity_id) is None, (
        "the single assertion write did NOT blank the name, so the second write in "
        "rename_entity may no longer be load bearing and its docstring is now wrong"
    )


def test_renaming_to_the_same_name_still_writes_the_cache_back(named):
    """A route that short circuits on "the string did not change" blanks the name.

    The supersession fires on a no-op rename too, because the emit key is new, so there is no
    such thing as a rename that touches nothing.
    """
    identity, writer, entity_id, actor = named
    rename_entity(identity, writer, entity_id=entity_id, display_name="Julie", actor=actor)
    assert _display_name(identity, entity_id) == "Julie"
    assert _names(identity) == [("Julie", "superseded"), ("Julie", "active")]


def test_a_rename_is_undone_by_saying_the_old_name_again(named):
    """An undo is a new decision that restores a state, not a hole in the history.

    The retired assertion is not reactivated: two rows would then claim the name at different
    times with no ordering between them, and 0006's index would refuse the second anyway.
    """
    identity, writer, entity_id, actor = named
    renamed = rename_entity(
        identity, writer, entity_id=entity_id, display_name="Julie R.", actor=actor
    )
    undo(identity, event_id=renamed.event_id, actor=actor)
    assert _display_name(identity, entity_id) == "Julie"
    assert [name for name, status in _names(identity) if status == "active"] == ["Julie"]
    assert len(_names(identity)) == 3, "the undo rewrote history instead of adding to it"


def test_renaming_an_entity_that_does_not_exist_is_refused(named):
    identity, writer, _entity_id, actor = named
    with pytest.raises(LookupError):
        rename_entity(
            identity, writer, entity_id=uuid.uuid4(), display_name="Nobody", actor=actor
        )


def test_a_rename_reaches_the_graph(named):
    """The snapshot the interface renders is what has to change, not only the table."""
    from orimera.graph import read_snapshot

    identity, writer, entity_id, actor = named
    rename_entity(identity, writer, entity_id=entity_id, display_name="Julie R.", actor=actor)
    snapshot = read_snapshot(identity.connection, identity.workspace_id)
    named_rows = [e for e in snapshot.entities if e.entity_id == entity_id]
    assert [e.display_name for e in named_rows] == ["Julie R."]
    claims = [
        (a.object_value, a.status)
        for a in named_rows[0].assertions
        if a.predicate_key == "name_is"
    ]
    assert ("Julie R.", "active") in claims


def test_a_rename_carries_the_actor_that_made_it(named):
    """A name is the one thing only a person may write, so the record says which person."""
    identity, writer, entity_id, actor = named
    renamed = rename_entity(
        identity, writer, entity_id=entity_id, display_name="Julie R.", actor=actor
    )
    row = identity.connection.execute(
        "select kind, stated_by_user, produced_by_run from assertion where assertion_id = %s",
        (renamed.assertion_id,),
    ).fetchone()
    assert row["kind"] == "user"
    assert row["stated_by_user"] == actor
    assert row["produced_by_run"] is None, "a user statement has no producing run"


def test_the_new_name_may_not_be_written_by_anything_but_the_user(named):
    """Invariant 4, on the path a rename opens. A rename must not become a route around it."""
    identity, _writer, entity_id, _actor = named
    with pytest.raises(psycopg.Error):
        identity.connection.execute(
            "insert into assertion (workspace_id, kind, predicate_id, subject_ref, object_value, "
            "emit_key, status) select %s, 'inference', predicate_id, %s::jsonb, %s::jsonb, %s, "
            "'active' from predicate where key = 'name_is'",
            (
                identity.workspace_id,
                f'{{"type": "entity", "id": "{entity_id}"}}',
                '"Aunt Marjorie"',
                f"attack:{uuid.uuid4()}",
            ),
        )

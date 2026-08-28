"""The epistemic guard in the mirror, exercised as SQL rather than through the repository.

``tests/test_ingest_persistence.py`` already proves that :class:`IngestRepository` refuses a
model-written name and a caption filed as a capture fact. That is a check in one Python method.
It is worth having, for the error message, but it is not the guarantee: any other code holding
the same connection could write the row directly and nothing would stop it. The review found the
production schema in exactly that position, with ``allows_kind`` declared and enforced nowhere,
so the same question has to be asked of the mirror.

So every test here goes round the repository and writes the assertion with raw SQL. What is
under test is the trigger in ``sqlite_mirror.sql``, not the Python.
"""

from __future__ import annotations

import sqlite3
import uuid

import pytest
from orimera.ingest.repository import IngestRepository, json_text, utc_now_text


@pytest.fixture
def repository(tmp_path, workspace_id):
    """A mirror schema with the one row an inference assertion needs to reference."""
    repository = IngestRepository.open(tmp_path / "guard.db", workspace_id)
    repository.connection.execute(
        "insert into pipeline_run (run_id, workspace_id, \"trigger\", started_at) "
        "values (?, ?, 'ingest', ?)",
        (str(RUN_ID), str(workspace_id), utc_now_text()),
    )
    return repository


RUN_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")
SPAN_IDS = json_text([str(uuid.UUID("00000000-0000-4000-8000-000000000002"))])


def _predicate_id(repository, key: str) -> int:
    row = repository.connection.execute(
        "select predicate_id from predicate where key = ?", (key,)
    ).fetchone()
    return int(row["predicate_id"])


def write_assertion(
    repository,
    *,
    kind: str,
    predicate_id: int,
    emit_key: str,
    object_value: str = "Aunt Marjorie",
) -> None:
    """Insert an assertion with raw SQL, deliberately bypassing IngestRepository."""
    repository.connection.execute(
        "insert into assertion (assertion_id, workspace_id, kind, predicate_id, subject_ref, "
        "object_value, asserted_at, support_span_ids, produced_by_run, stated_by_user, "
        "external_source, status, emit_key) "
        "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        (
            str(uuid.uuid4()),
            str(repository.workspace_id),
            kind,
            predicate_id,
            json_text({"type": "entity", "id": str(uuid.uuid4())}),
            json_text(object_value),
            utc_now_text(),
            SPAN_IDS,
            str(RUN_ID) if kind == "inference" else None,
            str(uuid.uuid4()) if kind == "user" else None,
            json_text({"url": "https://example.invalid"}) if kind == "external" else None,
            emit_key,
        ),
    )


@pytest.mark.parametrize("kind", ["inference", "capture", "external"])
def test_raw_sql_cannot_file_a_name_under_any_kind_but_user(repository, kind):
    """The mirror of the live probe: an insert that went round the application check."""
    with pytest.raises(sqlite3.IntegrityError, match="does not accept an assertion of this kind"):
        write_assertion(
            repository,
            kind=kind,
            predicate_id=_predicate_id(repository, "name_is"),
            emit_key=f"name:{kind}",
        )
    assert _count(repository) == 0


def test_raw_sql_may_still_file_a_name_stated_by_the_user(repository):
    """A guard that refused everything would pass every other test in this file."""
    write_assertion(
        repository,
        kind="user",
        predicate_id=_predicate_id(repository, "name_is"),
        emit_key="name:user",
    )
    assert _count(repository) == 1


def test_raw_sql_cannot_file_a_caption_as_a_capture_supported_fact(repository):
    with pytest.raises(sqlite3.IntegrityError, match="does not accept an assertion of this kind"):
        write_assertion(
            repository,
            kind="capture",
            predicate_id=_predicate_id(repository, "caption_is"),
            emit_key="caption:capture",
            object_value="a sunny beach",
        )
    assert _count(repository) == 0


def test_raw_sql_may_still_file_a_caption_as_an_inference(repository):
    write_assertion(
        repository,
        kind="inference",
        predicate_id=_predicate_id(repository, "caption_is"),
        emit_key="caption:inference",
        object_value="a sunny beach",
    )
    assert _count(repository) == 1


def test_an_unknown_predicate_is_refused_by_the_guard_itself(repository):
    """NOT EXISTS is false for a predicate that is not there, so the guard fails closed.

    The message is asserted, not merely the refusal. The foreign key would also reject this
    row, and a test satisfied by either could not tell a working guard from a missing one.
    """
    with pytest.raises(sqlite3.IntegrityError, match="does not accept an assertion of this kind"):
        write_assertion(
            repository, kind="user", predicate_id=999_999, emit_key="name:missing"
        )


def test_a_name_cannot_be_relabelled_as_an_inference_afterwards(repository):
    """Insert legally, then change the kind. An INSERT-only trigger would allow this."""
    write_assertion(
        repository,
        kind="user",
        predicate_id=_predicate_id(repository, "name_is"),
        emit_key="name:relabel",
    )
    with pytest.raises(sqlite3.IntegrityError, match="does not accept an assertion of this kind"):
        repository.connection.execute("update assertion set kind = 'inference'")
    assert _kinds(repository) == ["user"]


def test_an_inference_cannot_be_repointed_at_a_naming_predicate(repository):
    """The other half of the same hole: keep the kind, move the predicate."""
    write_assertion(
        repository,
        kind="inference",
        predicate_id=_predicate_id(repository, "caption_is"),
        emit_key="caption:repoint",
        object_value="a sunny beach",
    )
    with pytest.raises(sqlite3.IntegrityError, match="does not accept an assertion of this kind"):
        repository.connection.execute(
            "update assertion set predicate_id = ?", (_predicate_id(repository, "name_is"),)
        )


def test_a_naming_predicate_cannot_be_widened_to_admit_a_model(repository):
    """Guarding assertions alone leaves the rule one UPDATE on the vocabulary away from gone."""
    with pytest.raises(sqlite3.IntegrityError, match="naming predicate"):
        repository.connection.execute(
            "update predicate set allows_kind = ? where key = 'name_is'",
            (json_text(["user", "inference"]),),
        )


def test_a_new_naming_predicate_cannot_be_seeded_as_model_writable(repository):
    """The vocabulary churns weekly, so the rule cannot be a comparison against 'name_is'."""
    with pytest.raises(sqlite3.IntegrityError, match="naming predicate"):
        repository.connection.execute(
            "insert into predicate (predicate_id, key, value_schema, functional, allows_kind, "
            "writes_a_name, vocab_version) values (900, 'nickname_is', ?, 0, ?, 1, 1)",
            (json_text({"type": "string"}), json_text(["inference"])),
        )


def test_the_seeded_vocabulary_survives_its_own_guard(repository):
    """A trigger that refused the seed would surface as an empty vocabulary, not an error."""
    rows = repository.connection.execute(
        "select key, allows_kind, writes_a_name from predicate order by predicate_id"
    ).fetchall()
    by_key = {row["key"]: row for row in rows}
    assert len(rows) == 11
    assert by_key["name_is"]["writes_a_name"] == 1
    assert by_key["name_is"]["allows_kind"] == json_text(["user"])
    assert all(row["writes_a_name"] == 0 for row in rows if row["key"] != "name_is")


def _count(repository) -> int:
    return int(repository.connection.execute("select count(*) as n from assertion").fetchone()["n"])


def _kinds(repository) -> list[str]:
    rows = repository.connection.execute("select kind from assertion").fetchall()
    return [row["kind"] for row in rows]

"""R17: ``predicate.value_schema`` held a JSON Schema and nothing checked an object against it.

**The pair is the point, not either half.** ``jsonschema_violation`` enforces exactly the
keywords ``jsonschema_unsupported_keyword`` permits, and a vocabulary row using anything else is
refused when it is written. Coverage is total over a vocabulary that is total by refusal, which
is the only way a validator built out of seven keywords can be honest about what it guarantees.

The failure this is written against is R1, R4 and R16's shape a fourth time: a property stated
where enforcement would go, held up by less than it appears to be. A validator that checked the
top-level ``type`` and was named as though it checked the schema would be worse than nothing,
because the next reader would stop looking. So there is a test per keyword, and a test that the
two functions agree.
"""

from __future__ import annotations

import uuid

import psycopg
import pytest
from orimera.evidence import EvidenceAddress
from orimera.evidence.blob import BlobId
from psycopg.types.json import Jsonb

#: Every keyword this validator implements. Duplicated from migration 0014 on purpose: the test
#: below reads the live database and compares, so the two cannot drift silently.
SUPPORTED = {"type", "format", "maxLength", "required", "properties", "maximum", "minimum"}


def _violation(connection, schema, value):
    return connection.execute(
        "select jsonschema_violation(%s, %s) as v", (Jsonb(schema), Jsonb(value))
    ).fetchone()["v"]


def _unsupported(connection, schema):
    return connection.execute(
        "select jsonschema_unsupported_keyword(%s) as k", (Jsonb(schema),)
    ).fetchone()["k"]


# -- the two functions agree, and the vocabulary is inside what they cover --------------------


def test_every_seeded_predicate_uses_only_keywords_this_validator_enforces(repository):
    """The claim the whole design rests on, asked of the live table rather than of a document."""
    unenforceable = repository.connection.execute(
        "select key, jsonschema_unsupported_keyword(value_schema) as keyword from predicate "
        "where jsonschema_unsupported_keyword(value_schema) is not null"
    ).fetchall()
    assert unenforceable == [], unenforceable


def test_the_keyword_scan_reaches_every_depth(repository):
    """Five keywords appear at the top level. Two more are nested, and a top-level scan misses
    them.

    ``select distinct jsonb_object_keys(value_schema) from predicate`` reports `format`,
    `maxLength`, `properties`, `required` and `type`. ``reconstruction_rung_is`` nests `maximum`
    and `minimum` inside `properties`, so a validator built to that scan, with a seed-time
    refusal built to the same scan, would have refused a row migration 0005 already seeded.
    """
    connection = repository.connection
    top_level = {
        row["k"]
        for row in connection.execute(
            "select distinct jsonb_object_keys(value_schema) as k from predicate"
        ).fetchall()
    }
    assert "maximum" not in top_level and "minimum" not in top_level
    nested = connection.execute(
        "select value_schema from predicate where key = 'reconstruction_rung_is'"
    ).fetchone()["value_schema"]
    assert "maximum" in str(nested) and "minimum" in str(nested)
    # And the scan that matters reaches it.
    assert _unsupported(connection, {"type": "object", "properties": {"a": {"pattern": "^x"}}}) == (
        "pattern"
    )


def test_the_two_functions_cover_the_same_keywords(repository):
    """A keyword the refusal permits and the validator ignores is the defect this is against."""
    connection = repository.connection
    for keyword in SUPPORTED:
        schema = {"type": "object", "properties": {"a": {keyword: "x"}}}
        if keyword in ("type", "format"):
            schema = {"type": "object", "properties": {"a": {keyword: "string"}}}
        if keyword == "format":
            schema = {"type": "object", "properties": {"a": {"format": "date-time"}}}
        if keyword == "required":
            schema = {"type": "object", "properties": {"a": {"required": []}}}
        if keyword == "properties":
            schema = {"type": "object", "properties": {"a": {"properties": {}}}}
        if keyword in ("maxLength", "maximum", "minimum"):
            schema = {"type": "object", "properties": {"a": {keyword: 1}}}
        assert _unsupported(connection, schema) is None, keyword
    for keyword in ("pattern", "anyOf", "allOf", "enum", "additionalProperties", "items"):
        assert _unsupported(connection, {keyword: True}) == keyword


# -- one test per keyword, because a validator is only as good as its weakest one -------------


@pytest.mark.parametrize(
    ("schema", "value", "expected"),
    [
        ({"type": "string"}, "ok", None),
        ({"type": "string"}, {"a": 1}, "expected string, got object"),
        ({"type": "null"}, None, None),
        ({"type": "boolean"}, True, None),
        ({"type": "number"}, 1.5, None),
        ({"type": "integer"}, 3, None),
        ({"type": "integer"}, 2.5, "expected an integer, got number"),
        ({"type": "string", "maxLength": 3}, "abcd", "longer than 3 characters"),
        ({"type": "string", "maxLength": 3}, "abc", None),
        ({"type": "string", "format": "date-time"}, "2026-08-29T10:00:00Z", None),
        ({"type": "string", "format": "date-time"}, "not a date", "not a date-time"),
        ({"type": "object", "required": ["lat", "lon"]}, {"lat": 1}, "missing required key"),
        ({"type": "object", "required": ["lat"]}, {"lat": 1, "extra": 2}, None),
        (
            {"type": "object", "properties": {"rung": {"type": "integer", "maximum": 4}}},
            {"rung": 9},
            "greater than 4",
        ),
        (
            {"type": "object", "properties": {"rung": {"type": "integer", "minimum": 1}}},
            {"rung": 0},
            "less than 1",
        ),
        (
            {"type": "object", "properties": {"rung": {"type": "integer"}}},
            {"rung": 3},
            None,
        ),
        # A key `properties` names but the value does not carry is `required`'s question, not
        # this one, and JSON Schema says the same.
        ({"type": "object", "properties": {"a": {"type": "string"}}}, {}, None),
    ],
)
def test_one_keyword_at_a_time(repository, schema, value, expected):
    violation = _violation(repository.connection, schema, value)
    if expected is None:
        assert violation is None, violation
    else:
        assert violation is not None and expected in violation, violation


# -- a vocabulary row this cannot enforce is refused when it is written -----------------------


@pytest.mark.parametrize(
    ("schema", "named"),
    [
        ({"type": "string", "pattern": "^[A-Z]"}, "pattern"),
        ({"anyOf": [{"type": "string"}]}, "anyOf"),
        ({"type": "string", "format": "email"}, "format: email"),
        ({"type": ["string", "null"]}, "type given as array"),
        ({"type": "object", "properties": {"a": {"enum": [1]}}}, "enum"),
    ],
)
def test_a_schema_this_cannot_check_is_refused_and_the_keyword_is_named(
    repository, schema, named
):
    """The refusal has to NAME the thing, or the next person cannot decide about it.

    "Extend the validator, or take pg_jsonschema and accept what it does to the deployment
    target" is a decision. A constraint name is not enough to make it.
    """
    with pytest.raises(psycopg.errors.FeatureNotSupported) as raised:
        repository.connection.execute(
            "insert into predicate (key, value_schema, allows_kind, writes_a_name) "
            "values (%s, %s, %s, false)",
            (f"probe_{uuid.uuid4().hex[:8]}", Jsonb(schema), ["user"]),
        )
    assert named in str(raised.value), str(raised.value)
    assert "pg_jsonschema" in str(raised.value)
    repository.connection.execute("rollback")


def test_the_constraint_is_the_backstop_for_the_routes_the_trigger_cannot_see(repository):
    """A BEFORE trigger and a CHECK, the same pairing 0009 uses for the functional index.

    A restore revalidates the constraint and does not fire the trigger, so the constraint is
    what stops an unenforceable row arriving that way. Asserted by disabling the trigger, which
    is the only way to observe the second defence with the first in place.
    """
    connection = repository.connection
    connection.execute("alter table predicate disable trigger tg_predicate_schema_is_enforceable")
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "insert into predicate (key, value_schema, allows_kind, writes_a_name) "
                "values (%s, %s, %s, false)",
                (f"probe_{uuid.uuid4().hex[:8]}", Jsonb({"pattern": "^x"}), ["user"]),
            )
        connection.execute("rollback")
    finally:
        connection.execute(
            "alter table predicate enable trigger tg_predicate_schema_is_enforceable"
        )


# -- and an object is actually checked against it ---------------------------------------------


def test_an_object_that_does_not_match_its_predicate_is_refused(repository, workspace_id):
    """The probe that found R17: a predicate declaring a string accepted an object."""
    writer = repository.assertions
    with pytest.raises(Exception) as raised:
        writer.insert(
            kind="user",
            predicate_key="name_is",
            subject_ref={"type": "entity", "id": str(uuid.uuid4())},
            object_value={"not": "a name"},
            emit_key=f"probe:{uuid.uuid4()}",
            support_span_ids=[],
            stated_by_user=uuid.uuid4(),
        )
    assert "expected string, got object" in str(raised.value), str(raised.value)
    repository.connection.execute("rollback")


def test_a_name_longer_than_the_schema_allows_is_refused(repository):
    with pytest.raises(Exception) as raised:
        repository.assertions.insert(
            kind="user",
            predicate_key="name_is",
            subject_ref={"type": "entity", "id": str(uuid.uuid4())},
            object_value="x" * 201,
            emit_key=f"probe:{uuid.uuid4()}",
            support_span_ids=[],
            stated_by_user=uuid.uuid4(),
        )
    assert "longer than 200 characters" in str(raised.value)
    repository.connection.execute("rollback")


def test_a_claim_with_no_object_value_is_not_refused(repository, workspace_id):
    """``person_present`` says somebody is in this region and its object is genuinely nothing.

    A SQL NULL object_value means the claim carries no object value, which is a different fact
    from carrying a wrong one, and every ``object_ref`` assertion is in the same position.
    Requiring a value wherever a schema is not ``{"type":"null"}`` would refuse writes that are
    correct today, and it is not the rule the column states.
    """
    blob_id = BlobId(bytes(range(32)))
    repository.upsert_blob(blob_id, byte_size=1, media_type="image/jpeg", storage_key="k")
    span_id = repository.upsert_span(EvidenceAddress.photograph(blob_id))
    run = repository.connection.execute(
        "insert into pipeline_run (workspace_id, trigger) values (%s, 'ingest') returning run_id",
        (repository.workspace_id,),
    ).fetchone()
    assertion_id = repository.assertions.insert(
        kind="inference",
        predicate_key="person_present",
        subject_ref={"type": "span", "id": str(span_id)},
        object_value=None,
        emit_key=f"probe:{uuid.uuid4()}",
        support_span_ids=[span_id],
        produced_by_run=run["run_id"],
    )
    assert assertion_id is not None

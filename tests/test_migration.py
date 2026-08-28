"""Checks over the migration file itself.

No PostgreSQL server runs in this environment, and the schema is deeply PostgreSQL specific
(int8multirange, halfvec, uuidv7, GiST, row-level security), so it is not portable to SQLite
and no fake database is invented for it. What is checked here is everything that can be
checked without a server: that the file is well formed, that the constraints the invariants
depend on are actually present, and that the checksum machinery works.

The tests that need a real server are marked ``postgres`` and skip unless
ORIMERA_TEST_DATABASE_URL points at a scratch database. The behavioural half of them lives in
``test_epistemic_guard_postgres.py``: a text check cannot tell a rule the database enforces from
a rule the file merely describes, and that difference is the whole of defect 1.
"""

from __future__ import annotations

import re

import pytest
from orimera.migrations import Migration, migrations, verify_applied

from pg_harness import KNOWN_SHIMS, migrated_schema

SQL = next(iter(migrations())).sql


def test_there_is_exactly_one_migration_and_it_is_numbered():
    files = list(migrations())
    assert [m.version for m in files] == ["0001"]


def test_the_migration_is_a_single_transaction_with_no_down_path():
    statements = [line for line in SQL.splitlines() if line and not line.startswith("--")]
    assert statements[0].strip() == "begin;"
    assert statements[-1].strip() == "commit;"
    assert SQL.count("\nbegin;") == 1 and SQL.count("\ncommit;") == 1
    lowered = SQL.lower()
    # Forward-only. A drop in a migration is how a "reversible" schema quietly loses data.
    for banned in ("drop table", "drop column", "drop type", "rollback;"):
        assert banned not in lowered, f"forward-only migrations must not {banned}"


@pytest.mark.parametrize(
    "table",
    [
        "schema_migrations",
        "blob",
        "media_track",
        "capture",
        "clock_anchor",
        "evidence_span",
        "stage_registry",
        "pipeline_run",
        "pipeline_event",
        "artifact",
        "anchor_resolution",
        "predicate",
        "calibration",
        "assertion",
        "dispute",
        "retraction",
        "user_annotation",
        "occurrence",
        "entity",
        "entity_link",
        "match_proposal",
        "identity_rejection",
        "never_same",
        "identity_event",
        "derived_artifact",
        "embedding",
        "text_chunk",
        "consent_record",
        "tombstone",
        "purge_job",
        "job",
    ],
)
def test_every_required_table_exists(table):
    assert re.search(rf"create table (if not exists )?{table} \(", SQL)


def test_a_span_interval_is_half_open_and_never_empty():
    """The check that keeps [0, 0) out of the spine.

    Without it, an image span could be empty, and an empty range overlaps nothing, so the
    tombstone interval guard would pass every write it was meant to refuse.
    """
    assert "check (t_end_ns > t_start_ns)" in SQL
    assert "int8range(t_start_ns, t_end_ns, '[)')" in SQL


def test_the_extensions_the_indexes_need_are_declared():
    """btree_gist is not optional: without it three GiST indexes fail to build at all.

    Core GiST has no operator class for bytea or uuid, and every interval index in this schema
    leads with one of those.
    """
    for extension in ("vector", "pgcrypto", "pg_trgm", "btree_gist"):
        assert f"create extension if not exists {extension}" in SQL, extension


def test_the_span_digest_is_unique_per_workspace():
    assert "create unique index evidence_span_digest_uniq" in SQL


def test_the_interval_overlap_index_exists():
    """Co-presence, interval tombstones and 'what else is in this moment' all land on it."""
    assert "using gist (blob_sha256, t_range)" in SQL
    assert "using gist (capture_id, presence)" in SQL


def test_indexes_the_architecture_depends_on_are_present():
    for index in (
        "using gin (support_span_ids)",  # assertion -> spans
        "using gin (dep_index)",  # derived artifact invalidation
        "using gin (tsv)",  # lexical arm
        "using gin (body gin_trgm_ops)",  # trigram arm
        "using gist (workspace_id, valid_time)",  # bitemporal assertion lookup
        "using gin (output_artifact_ids)",  # assembly replay
    ):
        assert index in SQL, index


def test_an_occurrence_is_never_named_by_a_detector():
    """display_name lives on entity, never on occurrence, and only a 'user' assertion writes it."""
    occurrence_ddl = SQL.split("create table occurrence (")[1].split("\n);")[0]
    entity_ddl = SQL.split("create table entity (")[1].split("\n);")[0]
    assert "display_name" not in occurrence_ddl
    assert "display_name" in entity_ddl
    assert "'{user}'" in SQL  # name_is allows only the user kind


def test_a_confirmed_link_requires_a_human_decision():
    assert "constraint confirmed_needs_a_human" in SQL
    assert "state <> 'confirmed' or (decided_by is not null and method = 'user_confirm')" in SQL


def test_rejection_memory_is_keyed_by_evidence_not_by_a_pipeline_row():
    """Keying by occurrence_id resurrects every rejected proposal on the next detector run."""
    rejection_ddl = SQL.split("create table identity_rejection (")[1].split("\n);")[0]
    assert "occurrence_id" not in rejection_ddl
    assert "key_a" in rejection_ddl and "basis_digest" in rejection_ddl
    assert "revoked_at" in rejection_ddl  # undo is a revocation, never a DELETE
    assert "unique (workspace_id, scope, key_a, key_b, basis_digest)" in rejection_ddl


def test_the_four_provenance_classes_are_never_flattened():
    assert re.search(r"create type assertion_kind as enum", SQL)
    for kind in ("'capture'", "'inference'", "'user'", "'external'"):
        assert kind in SQL
    assert "constraint external_no_history" in SQL
    assert "constraint inference_support_required" in SQL


def test_allows_kind_is_enforced_rather_than_merely_declared():
    """The defect: allows_kind was a column no code path read.

    A live probe against the committed schema inserted kind='inference' against name_is with the
    value "Aunt Marjorie" and it landed with status='active'. The behavioural proof that this is
    now refused is in test_epistemic_guard_postgres.py; what is checked here is that the
    mechanism is present in the file at all, and that it has the four properties it needs.
    """
    assert "create or replace function tg_assertion_kind_is_allowed()" in SQL
    body = SQL.split("create or replace function tg_assertion_kind_is_allowed()")[1]
    body = body.split("$fn$;")[0]
    # It refuses rather than warns.
    assert "raise exception" in body
    # It fails closed on a missing predicate row rather than skipping the check.
    assert "v_allows is null" in body
    # `k = any(arr)` is NULL, not false, against a NULL element, and plpgsql accepts NULL.
    assert "coalesce(new.kind = any(v_allows), false)" in body
    # It cannot be defeated by a session that never declared a workspace.
    assert "perform assert_workspace_context(new.workspace_id);" in body


def test_the_epistemic_guard_covers_updates_as_well_as_inserts():
    """Otherwise insert-then-update is an unguarded route to the row the guard refuses."""
    assert (
        "before insert or update of kind, predicate_id on assertion" in SQL
    ), "the epistemic guard must fire on UPDATE too"


def test_the_vocabulary_cannot_be_edited_into_letting_a_model_name_someone():
    """Enforcement on assertions alone is one UPDATE on predicate away from irrelevant."""
    predicate_ddl = SQL.split("create table predicate (")[1].split("\n);")[0]
    assert "writes_a_name boolean not null default false" in predicate_ddl
    assert "constraint a_name_comes_only_from_the_user" in predicate_ddl
    assert "not writes_a_name or allows_kind <@ array['user']::assertion_kind[]" in predicate_ddl
    assert "constraint allows_kind_has_no_null_element" in predicate_ddl
    # The seed has to mark the one predicate the rule exists for.
    seed = SQL.split("insert into predicate")[1].split(";")[0]
    assert "'{user}',             true" in seed


def test_the_seed_comment_describes_enforcement_that_exists():
    """The comment that was false. It claimed a guarantee the schema did not provide.

    A comment is not testable in general, but this one names the mechanism, so the name can be
    required to resolve to something. If the guard is ever renamed or removed, this fails.
    """
    seed_section = SQL.split("-- 13. Seed vocabulary.")[1]
    assert "tg_assertion_kind_is_allowed()" in seed_section
    assert "a_name_comes_only_from_the_user" in seed_section
    for claimed in ("tg_assertion_kind_is_allowed()", "a_name_comes_only_from_the_user"):
        assert SQL.count(claimed) > 1, f"{claimed} is described but not defined"
    # The old wording, which was not true of the schema it annotated.
    assert "there is no code path in which a model writes a name onto anything" not in SQL


def test_the_embedding_column_carries_the_measured_width():
    """Runtime measurement recorded 4096 dimensions, and pgvector cannot index halfvec above
    4000."""
    embedding_ddl = SQL.split("create table embedding (")[1].split("\n);")[0]
    assert "halfvec(4096)" in embedding_ddl
    assert "check (dims = 4096)" in embedding_ddl
    # No ANN index on v: exact search is the decision, and it is recorded as one.
    assert "using hnsw" not in SQL and "using ivfflat" not in SQL


def test_a_re_import_after_deletion_is_possible():
    """Decision del-3. A total unique (workspace_id, blob_sha256) forbids it outright."""
    assert (
        "create unique index capture_live_bytes_uniq\n"
        "  on capture (workspace_id, blob_sha256) where deleted_at is null;" in SQL
    )
    capture_ddl = SQL.split("create table capture (")[1].split("\n);")[0]
    assert "unique (workspace_id, blob_sha256)" not in capture_ddl


def test_the_tombstone_guard_reads_only_columns_its_table_has():
    """The committed guard was one polymorphic function reading NEW.capture_id everywhere.

    plpgsql raises "record NEW has no field capture_id" the first time that fires on
    evidence_span. So each guard is checked against the columns of the table it is attached to.
    """
    columns = {
        "span": _column_names("evidence_span"),
        "occurrence": _column_names("occurrence"),
        "assertion": _column_names("assertion"),
        "embedding": _column_names("embedding"),
        "entity_link": _column_names("entity_link"),
    }
    for suffix, available in columns.items():
        # A parser that returned nothing would make the comparison below meaningless.
        assert "workspace_id" in available, f"failed to parse the columns of {suffix}"
        body = SQL.split(f"create or replace function tg_tombstone_guard_{suffix}()")[1]
        body = body.split("$fn$;")[0]
        referenced = set(re.findall(r"new\.([a-z_0-9]+)", body))
        assert referenced <= available, (
            f"tg_tombstone_guard_{suffix} reads {sorted(referenced - available)}, "
            f"which {suffix} does not have"
        )
        assert referenced, f"tg_tombstone_guard_{suffix} reads no NEW field at all"


#: Words that begin a table-level clause rather than a column.
_NOT_A_COLUMN = frozenset({"constraint", "unique", "primary", "check", "foreign", "exclude"})


def _column_names(table: str) -> set[str]:
    """Column names of one table, from its DDL.

    Columns sit at exactly two spaces of indentation; continuation lines of a multi-line CHECK
    are indented further, which is what keeps a string literal out of the result.
    """
    body = SQL.split(f"create table {table} (")[1].split("\n);")[0]
    names = set()
    for line in body.splitlines():
        match = re.match(r"^ {2}([a-z_0-9]+)\s+\S", line.split("--")[0])
        if match and match.group(1) not in _NOT_A_COLUMN:
            names.add(match.group(1))
    return names


def test_the_tombstone_guard_fires_on_every_derived_write_path():
    for table in ("evidence_span", "occurrence", "assertion", "embedding", "entity_link"):
        assert re.search(rf"before insert on {table}\b", SQL), table


def test_every_guard_asserts_the_workspace_context_before_it_trusts_a_lookup():
    """Otherwise the guard fails open, which is the worst direction for it to fail in.

    The guards read tombstone and evidence_span, both under FORCE row-level security. A session
    that never set orimera.workspace_id sees them as empty and finds no tombstone. A BYPASSRLS
    role skips the policy entirely. Triggers are bypassed by neither, so the assertion belongs
    here rather than only in the policy.
    """
    assert "create or replace function assert_workspace_context(" in SQL
    for guard in (
        "tg_tombstone_guard_span",
        "tg_tombstone_guard_occurrence",
        "tg_tombstone_guard_assertion",
        "tg_tombstone_guard_embedding",
        "tg_tombstone_guard_entity_link",
    ):
        body = SQL.split(f"create or replace function {guard}()")[1].split("$fn$;")[0]
        assert "perform assert_workspace_context(new.workspace_id);" in body, guard


def test_current_workspace_is_defined_before_anything_calls_it():
    assert SQL.index("create or replace function current_workspace()") < SQL.index(
        "perform assert_workspace_context"
    )


def test_the_tombstone_guard_uses_a_fresh_snapshot():
    """A stable function reuses the statement snapshot, which reopens the race it closes."""
    assert "language sql volatile" in SQL
    guard = SQL.split("create or replace function tombstone_blocks_span(")[1]
    assert "language sql stable" not in guard.split("$fn$")[0]


def test_a_capture_tombstone_is_not_keyed_by_the_blob_hash():
    """A hash-keyed tombstone would silently blocklist a deliberate re-import."""
    tombstone_ddl = SQL.split("create table tombstone (")[1].split("\n);")[0]
    assert "blob_sha256" not in tombstone_ddl
    assert "blocklist_hash" in tombstone_ddl  # the explicit opt-in for the other intent


def test_a_re_import_after_a_deletion_is_not_blocked_by_a_uniqueness_error():
    """del-3 needs a PARTIAL unique index.

    A total unique (workspace_id, blob_sha256) makes the soft-deleted row collide with the
    re-import, so the deliberate re-upload the decision promises fails with a uniqueness error
    instead of proceeding. Live duplicates must still collapse to one capture, which is what the
    partial index preserves.
    """
    capture_ddl = SQL.split("create table capture (")[1].split("\n);")[0]
    assert "unique (workspace_id, blob_sha256)" not in capture_ddl
    assert (
        "create unique index capture_live_bytes_uniq\n"
        "  on capture (workspace_id, blob_sha256) where deleted_at is null" in SQL
    )


def test_the_embedding_column_is_the_width_gate_0_measured():
    """Runtime measurement recorded Qwen3-Embedding-8B at 4096 dimensions, and that document wins on
    conflict.

    pgvector indexes halfvec to at most 4000 dimensions, so 4096 cannot carry an ANN index at
    all: the consequence of storing the real width is exact search. A declared HNSW or IVFFlat
    index over this column would not build.
    """
    embedding_ddl = SQL.split("create table embedding (")[1].split("\n) partition by list")[0]
    assert "halfvec(4096)" in embedding_ddl
    assert "dims" in embedding_ddl  # the real width is recorded per row
    assert "halfvec(1024)" not in embedding_ddl
    assert "using hnsw" not in SQL
    assert "using ivfflat" not in SQL


def test_row_level_security_is_forced_not_merely_enabled():
    """ENABLE alone is bypassed by the table owner, which makes every policy inert."""
    assert "force  row level security" in SQL
    assert SQL.count("enable row level security") == SQL.count("force  row level security")


def test_consent_is_deny_by_default_and_expires():
    consent_ddl = SQL.split("create table consent_record (")[1].split("\n);")[0]
    assert "expires_at            timestamptz not null" in consent_ddl
    assert "adult_attested        boolean not null check (adult_attested = true)" in consent_ddl
    assert "notice_text_sha256" in consent_ddl  # the exact wording shown, hashed
    assert "constraint operator_attested_has_no_demo_scopes" in consent_ddl


def test_checksum_drift_refuses_to_start(tmp_path):
    migration = next(iter(migrations()))
    verify_applied({migration.version: migration.checksum})  # clean
    with pytest.raises(RuntimeError, match="checksum drift"):
        verify_applied({migration.version: b"\x00" * 32})
    with pytest.raises(RuntimeError, match="absent from the package"):
        verify_applied({"9999": b"\x00" * 32})


def test_a_checksum_is_stable_across_reads():
    migration = next(iter(migrations()))
    assert migration.checksum == Migration(migration.version, migration.path).checksum


@pytest.mark.postgres
def test_the_migration_actually_applies():
    """Runs only against a real PostgreSQL server.

    Everything above is a text check. This is the test that proves the SQL parses, that the
    multirange types are present, and that every trigger attaches.

    The earlier version of this test applied the migration to ``public`` and then called
    ``rollback()``. That does not undo it: the migration contains its own ``commit;``, so the
    schema was already committed and the next run failed on "type already exists". The shared
    harness applies it to a throwaway schema and drops that schema instead.
    """
    with migrated_schema() as (_psycopg, conn, shims):
        assert set(shims) <= KNOWN_SHIMS, shims
        scratch = conn.execute("select current_schema()").fetchone()[0]
        tables = conn.execute(
            "select count(*) from information_schema.tables where table_schema = %s",
            (scratch,),
        ).fetchone()
        assert tables is not None and tables[0] >= 30
        triggers = conn.execute(
            "select trigger_name from information_schema.triggers "
            "where trigger_schema = %s",
            (scratch,),
        ).fetchall()
        names = {row[0] for row in triggers}
        assert "tg_assertion_kind_is_allowed" in names
        for guard in ("tg_guard_span", "tg_guard_occurrence", "tg_guard_assertion",
                      "tg_guard_embedding", "tg_guard_entity_link"):
            assert guard in names, guard

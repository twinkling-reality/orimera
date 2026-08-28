"""Workspace isolation, exercised as a role that cannot bypass it.

Every other PostgreSQL test in this suite connects as the database owner, who on a default
installation is also a superuser, and PostgreSQL states plainly that "superusers and roles with
the BYPASSRLS attribute always bypass the row security system". So those tests prove the
trigger guards, which fire for superusers too, and prove nothing at all about row-level
security. This file is the one that connects as a role which cannot bypass it.

Two distinct guarantees are checked, because they fail in different ways:

*   A **write** that names another workspace is refused by ``assert_workspace_context()`` inside
    a trigger. That is what the other tests cover.
*   A **read** of another workspace's rows is prevented only by the policy. There is no trigger
    on SELECT and there cannot be one. If the policy is inert, the read succeeds silently and
    nothing anywhere reports a problem.

The partition case is the one that was actually broken. ``embedding`` is partitioned by
workspace, migration 0001 enables FORCE row-level security on the parent, and the comment there
used to claim partitions inherit it. They do not: a query naming a partition directly is
governed by that partition's own policies, so a partition created without any was readable by
every workspace while the parent reported a correct zero.
"""

from __future__ import annotations

import os
import uuid

import psycopg
import pytest
from orimera.db.migrate import provision_workspace
from orimera.db.roles import EXECUTOR_ROLE, RUNTIME_ROLE, provision_runtime_role
from psycopg.rows import dict_row

from pg_harness import migrated_schema

pytestmark = pytest.mark.postgres

WIDE_VECTOR = "[" + ",".join(["0.5"] * 4096) + "]"


@pytest.fixture(scope="module")
def isolated():
    """A migrated schema holding one row per table for workspace A, and both runtime roles.

    The roles are provisioned under their real names rather than test-specific ones, because
    what is being checked is the privilege set an actual deployment gets. They are created
    without a password: local connections here authenticate by trust, and inventing a password
    for a role a deployment also uses would be worse than not having one.
    """
    with migrated_schema() as (_psycopg, admin):
        admin.row_factory = dict_row
        scratch = admin.execute("select current_schema()").fetchone()["current_schema"]
        provision_runtime_role(admin)
        provision_runtime_role(admin, role=EXECUTOR_ROLE, read_only=True)

        workspace_a, workspace_b = uuid.uuid4(), uuid.uuid4()
        for workspace in (workspace_a, workspace_b):
            admin.execute(
                "select set_config('orimera.workspace_id', %s, false)", (str(workspace),)
            )
            provision_workspace(admin, workspace)

        admin.execute(
            "select set_config('orimera.workspace_id', %s, false)", (str(workspace_a),)
        )
        digest = bytes(range(32))
        admin.execute(
            "insert into blob (blob_sha256, byte_size, media_type) values (%s, 1, 'image/jpeg')",
            (digest,),
        )
        admin.execute(
            "insert into capture (workspace_id, blob_sha256) values (%s, %s)",
            (workspace_a, digest),
        )
        span = admin.execute(
            "insert into evidence_span (workspace_id, blob_sha256, track_key, t_start_ns, "
            "t_end_ns, modality, span_digest) values (%s, %s, 'img', 0, 1, 'still_image', %s) "
            "returning span_id",
            (workspace_a, digest, bytes(32)),
        ).fetchone()["span_id"]
        admin.execute(
            "insert into embedding (workspace_id, family, ref_type, ref_id, model_ref, "
            "pipeline_version, dims, v) values (%s, 'text_chunk', 'span', %s, 'm', 1, 4096, %s)",
            (workspace_a, span, WIDE_VECTOR),
        )
        admin.commit()
        yield Isolated(scratch, workspace_a, workspace_b)


class Isolated:
    def __init__(self, scratch: str, workspace_a: uuid.UUID, workspace_b: uuid.UUID) -> None:
        self.scratch = scratch
        self.workspace_a = workspace_a
        self.workspace_b = workspace_b
        self._open: list[psycopg.Connection] = []

    def _dsn(self, role: str) -> str:
        base = os.environ["ORIMERA_TEST_DATABASE_URL"]
        separator = "&" if "?" in base else "?"
        return f"{base}{separator}user={role}"

    def connect(self, role: str, workspace: uuid.UUID) -> psycopg.Connection:
        connection = psycopg.connect(self._dsn(role), autocommit=True, row_factory=dict_row)
        connection.execute(f'set search_path to "{self.scratch}", public')
        connection.execute(
            "select set_config('orimera.workspace_id', %s, false)", (str(workspace),)
        )
        self._open.append(connection)
        return connection

    def partition_of(self, workspace: uuid.UUID) -> str:
        return f"embedding_ws_{workspace.hex}"

    def close(self) -> None:
        for connection in self._open:
            connection.close()
        self._open.clear()


@pytest.fixture
def scoped(isolated):
    yield isolated
    isolated.close()


def _count(connection: psycopg.Connection, table: str) -> int:
    return connection.execute(f'select count(*) as n from "{table}"').fetchone()["n"]


def test_the_runtime_roles_cannot_bypass_row_level_security(scoped):
    """If either role is a superuser or holds BYPASSRLS, every other test here is vacuous."""
    for role in (RUNTIME_ROLE, EXECUTOR_ROLE):
        connection = scoped.connect(role, scoped.workspace_a)
        row = connection.execute(
            "select r.rolsuper, r.rolbypassrls, current_user as who from pg_roles r "
            "where r.rolname = current_user"
        ).fetchone()
        assert row["who"] == role
        assert row["rolsuper"] is False, role
        assert row["rolbypassrls"] is False, role


@pytest.mark.parametrize("table", ["capture", "evidence_span", "embedding"])
def test_a_workspace_reads_its_own_rows_and_no_other_workspace_sees_them(scoped, table):
    """A policy that refused everything would pass the isolation half of this on its own."""
    mine = scoped.connect(RUNTIME_ROLE, scoped.workspace_a)
    theirs = scoped.connect(RUNTIME_ROLE, scoped.workspace_b)
    assert _count(mine, table) == 1
    assert _count(theirs, table) == 0


def test_naming_the_partition_directly_does_not_escape_the_policy(scoped):
    """The defect. The parent reported a correct zero while the partition handed the rows over.

    ``embedding`` is the table the privacy analysis is about, so this is the worst place in the
    schema for a read to leak, and the leak needed nothing but a different spelling of the table
    name.
    """
    partition = scoped.partition_of(scoped.workspace_a)
    theirs = scoped.connect(RUNTIME_ROLE, scoped.workspace_b)
    assert _count(theirs, "embedding") == 0
    assert _count(theirs, partition) == 0

    mine = scoped.connect(RUNTIME_ROLE, scoped.workspace_a)
    assert _count(mine, partition) == 1


def test_every_per_workspace_partition_carries_its_own_forced_policy(scoped):
    """Structural, so a partition created by some future path cannot quietly omit it."""
    admin = scoped.connect(RUNTIME_ROLE, scoped.workspace_a)
    partitions = admin.execute(
        "select c.relname, c.relrowsecurity, c.relforcerowsecurity "
        "from pg_class c join pg_namespace n on n.oid = c.relnamespace "
        "where n.nspname = %s and c.relkind = 'r' and c.relname like 'embedding_ws_%%'",
        (scoped.scratch,),
    ).fetchall()
    assert len(partitions) == 2, partitions
    for row in partitions:
        assert row["relrowsecurity"], row["relname"]
        assert row["relforcerowsecurity"], row["relname"]
        policies = admin.execute(
            "select policyname from pg_policies where schemaname = %s and tablename = %s",
            (scoped.scratch, row["relname"]),
        ).fetchall()
        assert [p["policyname"] for p in policies] == ["ws_isolation"], row["relname"]


def test_the_runtime_role_may_read_the_vocabulary_and_may_not_edit_it(scoped):
    """Defect R3. allows_kind is what stops a model filing a name, and it is workspace-global.

    A runtime role that can widen it disarms invariant 4 for every workspace at once, which is
    why this is a privilege question rather than a policy one: `predicate` carries no
    workspace_id, so there is no policy that could scope it.
    """
    connection = scoped.connect(RUNTIME_ROLE, scoped.workspace_a)
    assert connection.execute("select count(*) as n from predicate").fetchone()["n"] > 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
        connection.execute(
            "update predicate set allows_kind = array['user','inference']::assertion_kind[] "
            "where key = 'name_is'"
        )
    with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
        connection.execute(
            "insert into predicate (key, value_schema, allows_kind, writes_a_name) "
            "values ('nickname_is', '{\"type\":\"string\"}', "
            "array['inference']::assertion_kind[], false)"
        )


@pytest.mark.parametrize("table", ["capture", "evidence_span", "assertion", "occurrence"])
def test_no_runtime_role_may_delete_anything(scoped, table):
    """Deletion is a tombstone, a purge job and a separately authorised purger.

    A role that can DELETE can erase the record of what it erased, which is the one thing the
    whole deletion design exists to prevent.
    """
    for role in (RUNTIME_ROLE, EXECUTOR_ROLE):
        connection = scoped.connect(role, scoped.workspace_a)
        with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
            connection.execute(f"delete from {table}")


def test_the_executor_role_cannot_write_at_all(scoped):
    """The Selection executor runs a plan derived from model output. It holds SELECT and nothing
    else, so whatever happens upstream of it cannot become a write."""
    connection = scoped.connect(EXECUTOR_ROLE, scoped.workspace_a)
    assert _count(connection, "capture") == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
        connection.execute(
            "insert into capture (workspace_id, blob_sha256) values (%s, %s)",
            (scoped.workspace_a, bytes([7]) * 32),
        )
    with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
        connection.execute("update capture set device_id = 'edited'")


def test_a_session_with_no_workspace_declared_reads_nothing(scoped):
    """current_workspace() is NULL, `workspace_id = NULL` is NULL, and NULL is not true.

    This is the direction row-level security has to fail in. The alternative, a policy that
    treats an unset context as "no filter", would make every forgotten set_config a full
    cross-tenant read.
    """
    connection = psycopg.connect(scoped._dsn(RUNTIME_ROLE), autocommit=True, row_factory=dict_row)
    scoped._open.append(connection)
    connection.execute(f'set search_path to "{scoped.scratch}", public')
    assert connection.execute("select current_workspace() as w").fetchone()["w"] is None
    for table in ("capture", "evidence_span", "embedding", "assertion"):
        assert _count(connection, table) == 0, table

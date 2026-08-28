"""The runtime role, and the privileges that make row-level security mean anything.

Migration 0001 says, in the comment above its RLS section: "The query executor connects as a
role that owns nothing and does not hold BYPASSRLS. An executor connecting as the table owner
makes every policy here silently inert, which is the failure this comment exists to prevent."

That role did not exist. Everything, including the whole test suite, connected as the database
owner, who on a default installation is also a superuser, and a superuser bypasses row-level
security entirely. Every policy in the schema was inert and the tests that appeared to prove
workspace isolation were proving the trigger guards instead, which fire for superusers too. The
distinction is not academic: the trigger guards refuse a WRITE that names the wrong workspace,
while RLS is what stops a READ of another workspace's rows, and nothing was testing the second.

So this module creates the role and grants it exactly what it needs:

*   **No DELETE anywhere.** Deletion in this system is a tombstone plus a purge job plus the
    separately authorised purger in :mod:`orimera.store.base`. A runtime role that can DELETE
    can erase the record of what it erased.
*   **SELECT only on ``predicate``.** This is defect R3. ``allows_kind`` is what stops a model
    filing a name, and ``writes_a_name`` is what stops a new vocabulary row escaping the rule
    by being spelled differently. A runtime role that can UPDATE that table can disarm both,
    and the vocabulary is global rather than workspace-scoped, so one workspace could disarm it
    for every workspace. It is a lookup table the application reads and an administrator edits.
*   **SELECT only on ``schema_migrations``.** The application verifies its schema at boot; it
    does not record migrations.
*   **No ownership and no BYPASSRLS**, which is the whole point.

Every statement here is built with :mod:`psycopg.sql` rather than an f-string. Role names,
schema names and passwords all reach DDL, and DDL takes no bound parameters, so the choice is
between a composer that quotes correctly and a hand-rolled validator that has to be right.
"""

from __future__ import annotations

from typing import Final

import psycopg
from psycopg import sql

__all__ = [
    "EXECUTOR_ROLE",
    "READ_ONLY_TABLES",
    "RUNTIME_ROLE",
    "grant_workspace_partition",
    "provision_runtime_role",
]

#: The role the write path connects as: identity decisions, annotations, ingest. Owns nothing.
RUNTIME_ROLE: Final = "orimera_app"

#: The role the deterministic Selection executor connects as. Named in
#: architecture-overview.md section 5.2, which specifies a non-owner role without BYPASSRLS for
#: exactly this step. It holds SELECT and nothing else, so the step of the pipeline that runs a
#: plan derived from model output cannot write whatever happens above it.
EXECUTOR_ROLE: Final = "orimera_ro"

#: Tables the runtime may read and may not write. See the module docstring for why each.
READ_ONLY_TABLES: Final = ("predicate", "schema_migrations")

#: The vocabulary is administered, not generated. Without revoking this the role could insert a
#: predicate row even though it cannot update one.
_ADMIN_ONLY_SEQUENCES: Final = ("predicate_predicate_id_seq",)

#: The same key migration 0001 takes. Roles are cluster-global objects and `create role` and
#: `alter role` both write pg_authid, so two deployments starting at once get "tuple
#: concurrently updated" rather than one of them waiting. Observed with four test processes
#: against one database, which is what a CI runner is.
_ROLE_LOCK_KEY: Final = 119_622_309


def provision_runtime_role(
    connection: psycopg.Connection,
    *,
    role: str = RUNTIME_ROLE,
    password: str | None = None,
    read_only: bool = False,
) -> None:
    """Create ``role`` if it is absent and give it exactly the privileges it needs.

    Idempotent, so it is safe to call at every deployment. Called by an administrative
    connection, never by the runtime itself: a role that can grant itself privileges is not
    constrained by them.

    ``password`` is set only when supplied. A deployment that authenticates by certificate or
    by peer has no password to set, and a function that invented one would be creating a
    credential nobody asked for.

    ``read_only`` provisions the Selection executor role: SELECT and nothing else, on every
    table including the vocabulary.
    """
    writes = sql.SQL("select") if read_only else sql.SQL("select, insert, update")
    role_name = sql.Identifier(role)
    row = connection.execute("select current_schema()").fetchone()
    assert row is not None
    # Tolerates both row factories: an administrative connection may be anything the caller had.
    schema = sql.Identifier(row["current_schema"] if isinstance(row, dict) else row[0])

    with connection.transaction():
        connection.execute("select pg_advisory_xact_lock(%s)", (_ROLE_LOCK_KEY,))
        exists = connection.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone()
        if exists is None:
            connection.execute(sql.SQL("create role {} login nobypassrls").format(role_name))
        else:
            # An existing role may have been created with BYPASSRLS by hand. Saying so on every
            # deployment is cheaper than discovering it from a cross-workspace read.
            connection.execute(sql.SQL("alter role {} nobypassrls").format(role_name))
        if password is not None:
            connection.execute(
                sql.SQL("alter role {} password {}").format(role_name, sql.Literal(password))
            )

        connection.execute(sql.SQL("grant usage on schema {} to {}").format(schema, role_name))
        connection.execute(
            sql.SQL("grant {} on all tables in schema {} to {}").format(writes, schema, role_name)
        )
        if not read_only:
            connection.execute(
                sql.SQL("grant usage, select on all sequences in schema {} to {}").format(
                    schema, role_name
                )
            )
            for table in READ_ONLY_TABLES:
                connection.execute(
                    sql.SQL("revoke insert, update on {} from {}").format(
                        sql.Identifier(table), role_name
                    )
                )
            for sequence in _ADMIN_ONLY_SEQUENCES:
                connection.execute(
                    sql.SQL("revoke usage, select on sequence {} from {}").format(
                        sql.Identifier(sequence), role_name
                    )
                )
        # Per-workspace embedding partitions are created after this runs, by
        # provision_workspace. Default privileges cover the ones created later by this same
        # administrative role; grant_workspace_partition covers them explicitly, because a
        # default privilege that does not apply is silent and an explicit grant is not.
        connection.execute(
            sql.SQL("alter default privileges in schema {} grant {} on tables to {}").format(
                schema, writes, role_name
            )
        )


def grant_workspace_partition(connection: psycopg.Connection, partition: str) -> None:
    """Give both runtime roles access to one per-workspace partition, if they exist.

    Access, not exemption: the partition carries its own ``ws_isolation`` policy, so this grants
    the right to run a query that the policy then filters. A deployment that has not provisioned
    the roles yet is not an error here; it is the ordinary state of a development database.
    """
    for role, privileges in (
        (RUNTIME_ROLE, sql.SQL("select, insert, update")),
        (EXECUTOR_ROLE, sql.SQL("select")),
    ):
        present = connection.execute(
            "select 1 from pg_roles where rolname = %s", (role,)
        ).fetchone()
        if present is None:
            continue
        connection.execute(
            sql.SQL("grant {} on {} to {}").format(
                privileges, sql.Identifier(partition), sql.Identifier(role)
            )
        )

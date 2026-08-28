"""Applying migration 0001 to a real server, for the tests that need one.

Two things about this migration make a naive harness wrong, and both were learned by running it:

*   **The file carries its own ``begin;`` and ``commit;``.** Applying it and then calling
    ``rollback()`` does not undo it: the embedded COMMIT has already landed by the time control
    returns. A harness written that way silently leaves a schema behind, and the next run fails
    with "type assertion_kind already exists". So the schema is created inside a throwaway
    namespace and that namespace is dropped afterwards.
*   **The documented target is PostgreSQL 18 with pgvector, and most servers are neither.**
    Rather than skip everything on an older server, two features are substituted, and the
    substitutions are named and returned so a test can assert that nothing else was faked:
    ``uuidv7()`` becomes ``gen_random_uuid()``, and ``halfvec(4096)`` becomes ``bytea``. Neither
    is on the write path of any invariant tested through this harness.

Nothing outside the throwaway schema is read or written, and the database name must contain
"test" before the harness will touch it at all.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from orimera.migrations import migrations

#: The only substitutions this harness is allowed to make. A test asserts the set it actually
#: applied is a subset of this one, so a third missing feature fails rather than passes quietly.
KNOWN_SHIMS = frozenset({"uuidv7", "halfvec"})


def apply_migration(conn, scratch: str) -> list[str]:
    """Create schema ``scratch``, apply migration 0001 into it, return the shims used.

    ``search_path`` is set at session level rather than with SET LOCAL, because the migration
    commits partway through this function and a transaction-local setting would not survive it.
    """
    sql = next(iter(migrations())).sql
    shims: list[str] = []
    cursor = conn.cursor()
    cursor.execute(f'create schema "{scratch}"')
    cursor.execute(f'set search_path to "{scratch}", public')
    if not cursor.execute(
        "select 1 from pg_available_extensions where name = 'vector'"
    ).fetchone():
        sql = sql.replace("create extension if not exists vector;", "-- shimmed: no pgvector")
        sql = sql.replace("halfvec(4096)", "bytea")
        shims.append("halfvec")
    # to_regprocedure resolves through the search_path, so a uuidv7 left in some other schema by
    # an earlier crashed run does not count as "the server has it".
    if cursor.execute("select to_regprocedure('uuidv7()')").fetchone()[0] is None:
        cursor.execute(
            f'create function "{scratch}".uuidv7() returns uuid language sql volatile '
            "as $$ select gen_random_uuid() $$"
        )
        shims.append("uuidv7")
    cursor.execute(sql)
    return shims


@contextmanager
def migrated_schema() -> Iterator[tuple]:
    """Yield ``(psycopg, connection, shims)`` with 0001 applied to a throwaway schema.

    Skips the calling test when no database is configured, when psycopg is not installed, or
    when the configured database is not obviously a scratch one.
    """
    url = os.environ.get("ORIMERA_TEST_DATABASE_URL")
    if not url:
        # These tests are the only executable proof of invariant 4: that a model cannot write a
        # name into canonical state. Skipping them silently makes a default run look green while
        # the product's core epistemic guarantee is unverified. CI sets ORIMERA_REQUIRE_POSTGRES
        # so the absence is a failure there, not a shrug.
        if os.environ.get("ORIMERA_REQUIRE_POSTGRES"):
            pytest.fail(
                "ORIMERA_REQUIRE_POSTGRES is set but ORIMERA_TEST_DATABASE_URL is not. "
                "The epistemic guard tests cannot run, and they are not optional here."
            )
        pytest.skip("set ORIMERA_TEST_DATABASE_URL to a scratch PostgreSQL database")
    psycopg = pytest.importorskip("psycopg")
    if "test" not in url.rsplit("/", 1)[-1]:
        pytest.skip("refusing a database whose name does not contain 'test'")

    scratch = f"orimera_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(url) as conn:
        shims = apply_migration(conn, scratch)
        try:
            yield psycopg, conn, shims
        finally:
            # Uncommitted rows go back; the schema the migration committed has to be dropped.
            conn.rollback()
            conn.execute(f'drop schema "{scratch}" cascade')
            conn.commit()

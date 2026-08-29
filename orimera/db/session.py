"""Connections to the spine, and the two settings every one of them carries.

Neither setting is optional, and neither is a convenience.

*   **``orimera.workspace_id``.** 22 tables are under FORCE row-level security keyed on
    ``current_workspace()``, whose policy is ``workspace_id = current_workspace()`` and which
    reads exactly this setting. A twenty-third, ``consent_record``, is forced too and keyed on
    the tenant instead, which is why the number here counts the workspace-keyed ones rather than
    the forced ones. A session that does not declare a workspace therefore reads nothing and
    writes nothing: every SELECT returns empty and every INSERT fails its WITH CHECK. The
    tombstone and epistemic guards go further and call ``assert_workspace_context()``, which
    raises rather than failing open, because a guard that silently sees no tombstones is worse
    than no guard at all. So a connection is only ever handed out with a workspace attached.

*   **UTC.** PostgreSQL renders ``timestamptz`` in the session time zone, so a connection left
    on the server's local zone hands back ``2026-08-28T13:47-04:00`` for a column the code
    reads as UTC. Nothing breaks immediately; scene grouping still compares correct instants.
    What breaks is the moment one of those values is written into a payload field named ``utc``
    and read back somewhere that assumes the name.

The migration path is the one exception: :meth:`Database.unscoped` opens a connection with no
workspace, because applying DDL is not a workspace-scoped act and there is no workspace to name
before the schema exists.

Both hand out dictionary rows. Column names are the readable half of a query that already spells
out its own SELECT list, and a positional row makes adding a column to that list a silent
reindexing of every caller.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final

import psycopg
from psycopg.rows import dict_row

from orimera.errors import OrimeraError

__all__ = ["DATABASE_URL_ENV", "Database", "DatabaseNotConfigured", "set_workspace"]

#: Where the connection string comes from in every deployment. Tests point
#: ``ORIMERA_TEST_DATABASE_URL`` at a scratch database instead; nothing reads both.
DATABASE_URL_ENV: Final = "ORIMERA_DATABASE_URL"


class DatabaseNotConfigured(OrimeraError):
    """No connection string. Raised rather than defaulted, because a default would connect."""


def set_workspace(connection: psycopg.Connection, workspace_id: uuid.UUID) -> None:
    """Declare the workspace for the rest of this session.

    ``is_local`` is false so the setting outlives the transaction that sets it. A transaction-
    local setting would evaporate at the first commit and every subsequent statement would run
    with no workspace, which reads as "this workspace is empty" rather than as an error.
    """
    connection.execute(
        "select set_config('orimera.workspace_id', %s, false)", (str(workspace_id),)
    )


@dataclass(frozen=True, slots=True)
class Database:
    """A connection string, and the two ways to open a connection against it."""

    url: str

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Database:
        environ = os.environ if environ is None else environ
        url = environ.get(DATABASE_URL_ENV)
        if not url:
            raise DatabaseNotConfigured(
                f"{DATABASE_URL_ENV} is not set. Orimera has one data layer and it is "
                "PostgreSQL 18 with pgvector; there is no local fallback to run without."
            )
        return cls(url=url)

    @contextmanager
    def unscoped(self) -> Iterator[psycopg.Connection]:
        """A connection with no workspace. For migrations and for nothing else.

        Every table under row-level security is invisible through this connection, which is the
        intended effect: DDL does not belong to a workspace, and a caller that wanted workspace
        data and reached for this would get an empty result rather than another workspace's
        rows.
        """
        with psycopg.connect(self.url, row_factory=dict_row) as connection:
            connection.execute("set time zone 'UTC'")
            yield connection

    @contextmanager
    def session(self, workspace_id: uuid.UUID) -> Iterator[psycopg.Connection]:
        """A connection scoped to one workspace, in UTC, in autocommit.

        Autocommit is deliberate. Every multi-statement unit in this codebase already brackets
        itself with an explicit transaction, and an implicit one opened by the first statement
        would hold a snapshot open across whatever the caller does next, including a model call
        that takes ten seconds.
        """
        with psycopg.connect(self.url, autocommit=True, row_factory=dict_row) as connection:
            connection.execute("set time zone 'UTC'")
            set_workspace(connection, workspace_id)
            yield connection

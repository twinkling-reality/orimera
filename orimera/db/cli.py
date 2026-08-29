"""``orimera-db``: bring a database up to the schema and the roles this code expects.

One command, because there is only one correct order and offering a second way to ask is
offering a way to get it wrong. Migrations first, then the three roles.

**Run it as the SAME role that applies migrations.** ``provision_runtime_role`` ends with
``alter default privileges ... grant ... on tables``, and PostgreSQL applies default privileges
only to objects created by the role that executed that statement. Provision as one principal and
migrate as another and the grants stop covering tables a later migration adds, which surfaces as
``permission denied`` from a route rather than from here.

Passwords are optional. ``provision_runtime_role`` sets one only when given one, and a deployment
authenticating by certificate or by peer has none to set; inventing one would be creating a
credential nobody asked for.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Final

from orimera.db.migrate import apply_pending
from orimera.db.roles import (
    EXECUTOR_ROLE,
    PURGE_ROLE,
    RUNTIME_ROLE,
    provision_purge_role,
    provision_runtime_role,
)
from orimera.db.session import Database

__all__ = ["main"]

APP_ROLE_PASSWORD_ENV: Final = "ORIMERA_APP_ROLE_PASSWORD"
EXECUTOR_ROLE_PASSWORD_ENV: Final = "ORIMERA_EXECUTOR_ROLE_PASSWORD"
PURGE_ROLE_PASSWORD_ENV: Final = "ORIMERA_PURGE_ROLE_PASSWORD"


def provision(stream: Any) -> int:
    database = Database.from_env()
    report = apply_pending(database)
    for version in report.applied:
        print(f"  applied  {version}", file=stream)
    if not report.changed:
        print("schema: up to date", file=stream)

    with database.unscoped() as connection:
        provision_runtime_role(
            connection, role=RUNTIME_ROLE, password=os.environ.get(APP_ROLE_PASSWORD_ENV)
        )
        provision_runtime_role(
            connection,
            role=EXECUTOR_ROLE,
            password=os.environ.get(EXECUTOR_ROLE_PASSWORD_ENV),
            read_only=True,
        )
        provision_purge_role(connection, password=os.environ.get(PURGE_ROLE_PASSWORD_ENV))
    print(
        f"roles: {RUNTIME_ROLE} may select, insert and update and may not delete; "
        f"{EXECUTOR_ROLE} may select and nothing else; "
        f"{PURGE_ROLE} may mark bytes purged and may read every workspace's content hashes, "
        "which is the one question a shared blob makes unanswerable inside one workspace",
        file=stream,
    )
    return 0


def main(argv: list[str] | None = None, stream: Any = None) -> int:
    parser = argparse.ArgumentParser(
        prog="orimera-db", description="Apply pending migrations, then grant the two roles."
    )
    parser.parse_args(argv)
    return provision(stream or sys.stdout)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

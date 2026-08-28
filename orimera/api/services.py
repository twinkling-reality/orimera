"""What a running instance is wired to, resolved once at startup rather than per request.

Three things, and the interesting one is the second.

*   **A write database and a read database.** The Selection executor is specified to connect as
    ``orimera_ro``, "a non-owner role that owns nothing and lacks BYPASSRLS", so that the step of
    the pipeline running a plan derived from model output cannot write whatever happened
    upstream of it. That is a second connection string, and when it is absent this says so at
    startup instead of quietly running queries as the writer. A defence that is off and silent
    is worse than one that is absent, because it still reads as present.
*   **The object store**, which is what an evidence citation resolves against.
*   **The model client**, built lazily. Two endpoints out of the whole surface need a model, and
    an instance with no credential should serve the other endpoints rather than refuse to start.

Nothing here is a global. The application holds one :class:`Services` and hands it to routes
through a dependency, so a test builds its own and a second instance in one process is possible
rather than a thing that would need to be discovered.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from orimera.api.authorisation import TokenDirectory, load_token_directory
from orimera.db.session import DATABASE_URL_ENV, Database
from orimera.models.client import ModelClient
from orimera.store.base import ContentAddressedStore
from orimera.store.local import LocalContentAddressedStore

__all__ = [
    "DATA_DIR_ENV",
    "READONLY_DATABASE_URL_ENV",
    "Services",
    "build_services",
]

#: The connection string the Selection executor uses. Optional, and its absence is reported.
READONLY_DATABASE_URL_ENV: Final = "ORIMERA_READONLY_DATABASE_URL"

#: Where the content-addressed store lives. The same directory the ingest CLI writes.
DATA_DIR_ENV: Final = "ORIMERA_DATA_DIR"

_DEFAULT_DATA_DIR: Final = ".orimera/local"


@dataclass(frozen=True, slots=True)
class Services:
    """Everything a request might need, and a note about what is not configured."""

    database: Database
    readonly_database: Database
    store: ContentAddressedStore
    tokens: TokenDirectory
    #: True when the executor is running as the writer because no read-only role was configured.
    executor_shares_the_write_role: bool
    #: None when no model credential is configured. The two endpoints that need one say so.
    model_client: ModelClient | None

    @property
    def warnings(self) -> tuple[str, ...]:
        """What this instance is running without. Surfaced by ``/readyz``, never swallowed."""
        notes: list[str] = []
        if self.executor_shares_the_write_role:
            notes.append(
                f"{READONLY_DATABASE_URL_ENV} is not set, so the Selection executor is running "
                "as the write role. Row-level security still applies, but the read-only "
                "guarantee this instance would otherwise have does not."
            )
        if self.model_client is None:
            notes.append(
                "no model credential is configured, so the endpoints that plan a Selection from "
                "a question or compose an answer will refuse rather than guess."
            )
        return tuple(notes)


def build_services(
    environ: Mapping[str, str] | None = None, *, model_client: ModelClient | None = None
) -> Services:
    """Resolve configuration into services, or fail at startup with the reason.

    ``model_client`` is injectable so a test can supply a scripted one. Everything else comes
    from the environment, because it is deployment configuration rather than a decision the
    code gets to make.
    """
    environ = os.environ if environ is None else environ
    database = Database.from_env(environ)
    readonly_url = environ.get(READONLY_DATABASE_URL_ENV)
    data_dir = Path(environ.get(DATA_DIR_ENV, _DEFAULT_DATA_DIR))

    client = model_client
    if client is None and environ.get("NEBIUS_API_KEY"):
        client = ModelClient()

    return Services(
        database=database,
        readonly_database=Database(url=readonly_url) if readonly_url else database,
        store=LocalContentAddressedStore(data_dir / "blobs"),
        tokens=load_token_directory(environ),
        executor_shares_the_write_role=readonly_url is None,
        model_client=client,
    )


def describe_configuration(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """What an operator needs to set, and whether it is set. Never the values themselves."""
    environ = os.environ if environ is None else environ
    return {
        name: "set" if environ.get(name) else "missing"
        for name in (
            DATABASE_URL_ENV,
            READONLY_DATABASE_URL_ENV,
            DATA_DIR_ENV,
            "ORIMERA_API_TOKENS",
            "NEBIUS_API_KEY",
        )
    }

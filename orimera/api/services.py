"""What a running instance is wired to, resolved once at startup rather than per request.

Four things, and the interesting one is the second.

*   **A write database and a read database.** The Selection executor is specified to connect as
    ``orimera_ro``, "a non-owner role that owns nothing and lacks BYPASSRLS", so that the step of
    the pipeline running a plan derived from model output cannot write whatever happened
    upstream of it. That is a second connection string, and when it is absent this says so at
    startup instead of quietly running queries as the writer. A defence that is off and silent
    is worse than one that is absent, because it still reads as present.
*   **The object store**, which is what an evidence citation resolves against.
*   **The model client**, built lazily. Two endpoints out of the whole surface need a model, and
    an instance with no credential should serve the other endpoints rather than refuse to start.
*   **Whether this instance drains the derivative queue.** ``POST /intake`` runs the intake stage
    in the request and queues the rest by capture id, so something has to drain it. In one
    process that is a daemon thread here. An instance that leaves it to somebody else says so in
    ``/readyz``, because a queue nobody drains and a queue drained elsewhere look identical from
    the outside and only one of them is a deployment.

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
from orimera.ingest.vision import NebiusVisionModel
from orimera.ingest.worker import DerivativeWorker
from orimera.models.client import ModelClient
from orimera.store.base import ContentAddressedStore
from orimera.store.local import LocalContentAddressedStore

__all__ = [
    "DATA_DIR_ENV",
    "DERIVATIVE_WORKER_ENV",
    "READONLY_DATABASE_URL_ENV",
    "Services",
    "build_services",
]

#: The connection string the Selection executor uses. Optional, and its absence is reported.
READONLY_DATABASE_URL_ENV: Final = "ORIMERA_READONLY_DATABASE_URL"

#: Where the content-addressed store lives. The same directory the ingest CLI writes.
DATA_DIR_ENV: Final = "ORIMERA_DATA_DIR"

#: Set to ``0``, ``false`` or ``off`` to serve the API without draining the derivative queue in
#: this process. Anything else, including absence, runs it: an instance serving ``POST /intake``
#: with nothing draining the queue is an upload that never finishes, and that is the wrong
#: default to arrive at by saying nothing.
DERIVATIVE_WORKER_ENV: Final = "ORIMERA_DERIVATIVE_WORKER"

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
    #: True when this process drains the derivative queue itself. Defaulted to False so that a
    #: hand-constructed Services, which is how every test builds one, does not start a thread
    #: nobody asked for. ``build_services`` reads the environment and defaults the other way.
    runs_derivative_worker: bool = False

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
        if not self.runs_derivative_worker:
            notes.append(
                f"{DERIVATIVE_WORKER_ENV} is off, so this process serves POST /intake and does "
                "not drain what that route queues. Uploaded photographs are in the library and "
                "their rendition, vision and depth stages will not run until something else "
                "drains the queue."
            )
        elif self.model_client is None:
            notes.append(
                "the derivative worker is running without a vision model, so uploaded "
                "photographs get a rendition and no observations. A later pass with a "
                "credential configured completes them: every stage is keyed by content and "
                "re-running costs nothing for the stages that already ran."
            )
        if self.runs_derivative_worker:
            notes.append(
                "the derivative worker runs no depth model, so an uploaded photograph is a rung "
                "4 region until `orimera-ingest --reconstruct` runs over the same corpus. That "
                "is a real rung with a real experience, and reconstruction quality never "
                "participates in the truth guarantee."
            )
        return tuple(notes)

    def build_derivative_worker(self) -> DerivativeWorker | None:
        """The thread that finishes what ``POST /intake`` starts, or None when it is off.

        **The worker is handed the workspaces as a value.** ``orimera.ingest`` sits under
        ``orimera.api`` in the layers contract, so a worker that imported the token directory to
        find out which workspaces exist would invert the layering, and ``uv run lint-imports``
        says so rather than a reviewer.

        **No depth model**, deliberately. The reconstruction stack is a large optional
        dependency and an API image that carries it is a different image. An uploaded photograph
        is therefore rung 4 until a reconstruction pass runs, which ``warnings`` states rather
        than leaves to be discovered.
        """
        if not self.runs_derivative_worker:
            return None
        return DerivativeWorker(
            self.database,
            self.store,
            self.tokens.workspaces,
            vision=NebiusVisionModel(self.model_client) if self.model_client else None,
        )


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
        runs_derivative_worker=_enabled(environ.get(DERIVATIVE_WORKER_ENV)),
    )


def _enabled(value: str | None) -> bool:
    """Absent means on. Only an explicit off is off, and it has to be spelled like one."""
    return (value or "").strip().lower() not in ("0", "false", "off", "no")


def describe_configuration(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """What an operator needs to set, and whether it is set. Never the values themselves."""
    environ = os.environ if environ is None else environ
    return {
        name: "set" if environ.get(name) else "missing"
        for name in (
            DATABASE_URL_ENV,
            READONLY_DATABASE_URL_ENV,
            DATA_DIR_ENV,
            DERIVATIVE_WORKER_ENV,
            "ORIMERA_API_TOKENS",
            "NEBIUS_API_KEY",
        )
    }

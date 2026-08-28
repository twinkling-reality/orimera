"""The application: routers, and the one place a domain error becomes a status code.

Two things live here and nothing else does.

**The error map.** Every domain error in this codebase already says precisely what went wrong,
and the API's job is to turn that into a status code without losing the distinction or inventing
one. Three of the mappings are decisions rather than conventions:

*   ``unknown_reference`` is **404, never 403**. ``evaluation-methodology.md`` M10: "404, never
    403, so the surface is not an existence oracle. Nonexistent and foreign IDs return the
    identical code." A 403 would confirm that an id exists and belongs to somebody, which is
    exactly the thing a cross-tenant probe is looking for.
*   ``not_authorised`` **is** a 403, and that is not a contradiction. It means the session may
    not do a thing it asked to do with its own workspace's data, so there is no other tenant to
    leak the existence of.
*   A tombstoned address is **410 Gone**, not 404. The user deleted it, which is a different
    fact from it never having existed, and it is a fact they are entitled to.

**The startup check.** The application verifies at boot that the schema it is about to query is
the schema its migration files describe, and refuses to start otherwise. An edited migration is a
silent schema fork, and the failure it produces later is a wrong answer rather than an error.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Final

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from orimera.api.authorisation import TokenNotAccepted
from orimera.api.routes import evidence, graph, health, identity, selection
from orimera.api.services import Services, build_services
from orimera.db.migrate import verify_schema
from orimera.errors import (
    BlobNotFoundError,
    EpistemicViolation,
    IntegrityError,
    TombstonedError,
)
from orimera.identity.decisions import (
    AlreadyIdentified,
    IdentityError,
    NeverSame,
    NotUndoable,
    UnknownSubject,
)
from orimera.selection.validation import RejectionCode, SelectionRejected

__all__ = ["create_app"]

#: Which rejection code means which status. See the module docstring for why unknown_reference
#: is a 404 and not_authorised is a 403.
_REJECTION_STATUS: Final[dict[RejectionCode, int]] = {
    RejectionCode.MALFORMED_PLAN: 400,
    RejectionCode.COST_BOUND_EXCEEDED: 400,
    RejectionCode.UNKNOWN_REFERENCE: 404,
    RejectionCode.NOT_AUTHORISED: 403,
}


def _problem(status: int, code: str, detail: str) -> JSONResponse:
    """One response shape for every failure, so a client has one thing to parse."""
    return JSONResponse(status_code=status, content={"code": code, "detail": detail})


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Refuse to serve a schema this code does not recognise."""
    verify_schema(app.state.services.database)
    yield


def create_app(services: Services | None = None, *, verify: bool = True) -> FastAPI:
    """Build the application. ``services`` is injectable so a test does not read the environment.

    ``verify=False`` skips the boot-time schema check, and exists for the tests that build an app
    against a throwaway schema the migration runner has not recorded. Nothing in a deployment
    should pass it.
    """
    app = FastAPI(
        title="Orimera",
        summary="A personal world memory model. Every historical claim resolves to its source.",
        version="0.1.0",
        lifespan=_lifespan if verify else None,
    )
    app.state.services = services or build_services()

    app.include_router(health.router)
    app.include_router(graph.router)
    app.include_router(selection.router)
    app.include_router(identity.router)
    app.include_router(evidence.router)

    @app.exception_handler(TokenNotAccepted)
    async def _unauthenticated(_request: Request, exc: TokenNotAccepted) -> JSONResponse:
        return _problem(401, "unauthenticated", str(exc))

    @app.exception_handler(SelectionRejected)
    async def _rejected(_request: Request, exc: SelectionRejected) -> JSONResponse:
        return _problem(_REJECTION_STATUS[exc.code], str(exc.code), exc.detail)

    @app.exception_handler(UnknownSubject)
    async def _unknown(_request: Request, exc: UnknownSubject) -> JSONResponse:
        # Same code as a nonexistent id, for the same reason: the identity surface is not an
        # existence oracle either.
        return _problem(404, "unknown_reference", str(exc))

    @app.exception_handler(AlreadyIdentified)
    async def _conflict(_request: Request, exc: AlreadyIdentified) -> JSONResponse:
        return _problem(409, "already_identified", str(exc))

    @app.exception_handler(NeverSame)
    async def _never_same(_request: Request, exc: NeverSame) -> JSONResponse:
        return _problem(409, "never_same", str(exc))

    @app.exception_handler(NotUndoable)
    async def _not_undoable(_request: Request, exc: NotUndoable) -> JSONResponse:
        return _problem(409, "not_undoable", str(exc))

    @app.exception_handler(IdentityError)
    async def _identity(_request: Request, exc: IdentityError) -> JSONResponse:
        return _problem(409, "identity_conflict", str(exc))

    @app.exception_handler(EpistemicViolation)
    async def _epistemic(_request: Request, exc: EpistemicViolation) -> JSONResponse:
        # 422 rather than 400: the request was well formed and the claim it carried was not
        # permitted under the provenance class it asked for.
        return _problem(422, "epistemic_violation", str(exc))

    @app.exception_handler(TombstonedError)
    async def _tombstoned(_request: Request, exc: TombstonedError) -> JSONResponse:
        return _problem(410, "tombstoned", str(exc))

    @app.exception_handler(BlobNotFoundError)
    async def _missing(_request: Request, _exc: BlobNotFoundError) -> JSONResponse:
        return _problem(404, "unknown_reference", "no such evidence")

    @app.exception_handler(IntegrityError)
    async def _integrity(_request: Request, exc: IntegrityError) -> JSONResponse:
        # Deliberately loud and deliberately not a 404. Stored bytes that do not hash to the key
        # they are stored under means a citation has stopped verifying, and serving anything at
        # all here would hide it.
        return _problem(500, "integrity_failure", str(exc))

    return app

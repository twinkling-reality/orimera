"""The four things a route is given, and why a route is given nothing else.

A route in this API validates and delegates. It receives a session, a connection already scoped
to that session's workspace, and whichever repository it needs, and it hands the work to the
package that owns it. There is no business logic in a route, which is a claim that is checkable:
every route function in this package is short enough to read in one screen, and the logic it
delegates to has its own tests that do not go through HTTP.

The connection dependency is where the workspace binding actually happens. It opens a session
through :meth:`orimera.db.session.Database.session`, which issues
``set_config('orimera.workspace_id', ...)`` before handing the connection over, so every query a
route runs is already under row-level security scoped to the caller. A route cannot forget,
because a route never opens a connection.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

import psycopg
from fastapi import Depends, Header, Request

from orimera.api.authorisation import TokenNotAccepted
from orimera.api.services import Services
from orimera.epistemics.assertions import AssertionWriter
from orimera.identity import IdentityRepository
from orimera.selection.validation import Session

__all__ = [
    "CurrentSession",
    "ReadOnlyConnection",
    "ScopedConnection",
    "WorkspaceIdentity",
    "current_session",
    "get_services",
]


def get_services(request: Request) -> Services:
    return request.app.state.services


def current_session(
    request: Request, authorization: Annotated[str | None, Header()] = None
) -> Session:
    """Resolve the bearer token to a session, or refuse.

    The scheme is checked before the token is looked up, so a caller sending a cookie or a basic
    credential gets the same refusal as a caller sending nothing, rather than having their value
    compared against the configured secrets.
    """
    scheme, _, presented = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not presented:
        raise TokenNotAccepted("expected an Authorization header of the form 'Bearer <token>'")
    return get_services(request).tokens.session_for(presented.strip())


CurrentSession = Annotated[Session, Depends(current_session)]


def scoped_connection(
    request: Request, session: CurrentSession
) -> Iterator[psycopg.Connection]:
    """A connection bound to the caller's workspace, for the duration of one request."""
    with get_services(request).database.session(session.workspace_id) as connection:
        yield connection


def readonly_connection(
    request: Request, session: CurrentSession
) -> Iterator[psycopg.Connection]:
    """The same, as the role that holds SELECT and nothing else, when one is configured."""
    services = get_services(request)
    with services.readonly_database.session(session.workspace_id) as connection:
        yield connection


ScopedConnection = Annotated[psycopg.Connection, Depends(scoped_connection)]
ReadOnlyConnection = Annotated[psycopg.Connection, Depends(readonly_connection)]


class WorkspaceIdentity:
    """The identity repositories, built on the request's own connection.

    A small container rather than three separate dependencies, because every identity route
    needs the same three and constructing them is where the workspace is asserted a second time.
    """

    def __init__(self, connection: ScopedConnection, session: CurrentSession) -> None:
        self.connection = connection
        self.session = session
        self.repository = IdentityRepository(connection, session.workspace_id)
        self.assertions = AssertionWriter(connection, session.workspace_id)

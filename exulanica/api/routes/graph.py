"""The entity graph, as one snapshot at one state version.

The payload and the reads that build it are ``exulanica.graph``, one layer down, because eight SQL
statements is not what this package means by "routes validate and delegate". What is left here
is the route: take the workspace off the session, return the snapshot.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from exulanica.api.dependencies import CurrentSession, ReadOnlyConnection, get_services
from exulanica.api.services import Services
from exulanica.graph import GraphPayload, read_snapshot

router = APIRouter(prefix="/graph", tags=["graph"])


@router.get("", summary="The entity graph, as one snapshot at one state version.")
def snapshot(
    connection: ReadOnlyConnection,
    session: CurrentSession,
    services: Annotated[Services, Depends(get_services)],
) -> GraphPayload:
    with connection.transaction():
        connection.execute("set transaction isolation level repeatable read read only")
        return read_snapshot(connection, session.workspace_id, services.store)

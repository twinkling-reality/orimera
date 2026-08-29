"""The entity graph, as one snapshot at one state version.

The payload and the reads that build it are ``orimera.graph``, one layer down, because eight SQL
statements is not what this package means by "routes validate and delegate". What is left here
is the route: take the workspace off the session, return the snapshot.
"""

from __future__ import annotations

from fastapi import APIRouter

from orimera.api.dependencies import CurrentSession, ReadOnlyConnection
from orimera.graph import GraphPayload, read_snapshot

router = APIRouter(prefix="/graph", tags=["graph"])


@router.get("", summary="The entity graph, as one snapshot at one state version.")
def snapshot(connection: ReadOnlyConnection, session: CurrentSession) -> GraphPayload:
    return read_snapshot(connection, session.workspace_id)

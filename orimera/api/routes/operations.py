"""Authorised operational visibility for the caller's own derivative queue."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter

from orimera.api.dependencies import CurrentSession, ScopedConnection
from orimera.ingest.operations import derivative_job_events, derivative_job_metrics

router = APIRouter(prefix="/operations", tags=["operations"])


@router.get("/derivative-jobs", summary="Measured derivative queue health for this workspace.")
def jobs(connection: ScopedConnection, session: CurrentSession) -> dict[str, Any]:
    return derivative_job_metrics(connection, session.workspace_id)


@router.get(
    "/derivative-jobs/{job_id}/events",
    summary="Durable delivery replay for one derivative job.",
)
def job_events(
    job_id: uuid.UUID, connection: ScopedConnection, session: CurrentSession
) -> list[dict[str, Any]]:
    return derivative_job_events(connection, session.workspace_id, job_id)

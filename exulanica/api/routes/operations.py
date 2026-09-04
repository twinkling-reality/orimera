"""Authorised operational visibility for the caller's own derivative queue."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, status

from exulanica.api.dependencies import CurrentSession, ScopedConnection
from exulanica.ingest.operations import (
    derivative_job_events,
    derivative_job_metrics,
    reconstruction_scene_job,
    reconstruction_scene_metrics,
    retry_reconstruction_scene_job,
)

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


@router.get(
    "/reconstruction-scenes",
    summary="Measured reconstruction dependency and queue health for this workspace.",
)
def reconstruction_scenes(connection: ScopedConnection, session: CurrentSession) -> dict[str, Any]:
    return reconstruction_scene_metrics(connection, session.workspace_id)


@router.get(
    "/reconstruction-scenes/{job_id}",
    summary="Exact inputs, state and outputs for one reconstruction build.",
)
def reconstruction_scene_detail(
    job_id: uuid.UUID, connection: ScopedConnection, session: CurrentSession
) -> dict[str, Any]:
    result = reconstruction_scene_job(connection, session.workspace_id, job_id)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "reconstruction build not found")
    return result


@router.post(
    "/reconstruction-scenes/{job_id}/retry",
    summary="Make one retryable failed reconstruction build immediately eligible.",
)
def retry_reconstruction_scene(
    job_id: uuid.UUID, connection: ScopedConnection, session: CurrentSession
) -> dict[str, str]:
    with connection.transaction():
        result = retry_reconstruction_scene_job(
            connection,
            session.workspace_id,
            job_id,
        )
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "reconstruction build not found")
    if result != "retryable":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"reconstruction build is {result} and cannot be retried",
        )
    return {"status": "retryable"}

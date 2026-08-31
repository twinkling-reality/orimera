"""Workspace-scoped operational projections over the durable derivative delivery ledger."""

from __future__ import annotations

import uuid
from typing import Any

import psycopg

from orimera.ingest.derivative_queue import DERIVATIVES

__all__ = ["derivative_job_events", "derivative_job_metrics"]


def derivative_job_metrics(
    connection: psycopg.Connection, workspace_id: uuid.UUID
) -> dict[str, Any]:
    """Queue depth, age, attempts, duration, cost and terminal failure classes.

    Every value is computed from a durable row. A missing duration or cost remains absent from
    its population rather than being treated as zero work.
    """
    row = connection.execute(
        "select "
        " count(*) filter (where state = 'queued') as queued, "
        " count(*) filter (where state = 'running') as running, "
        " count(*) filter (where state in "
        "   ('done','failed','cancelled','missing','unavailable')) as terminal, "
        " max(attempts) as max_attempts, "
        " avg(duration_ms) filter (where duration_ms is not null) as average_duration_ms, "
        " max(duration_ms) filter (where duration_ms is not null) as maximum_duration_ms, "
        " extract(epoch from (clock_timestamp() - min(created_at) "
        "   filter (where state = 'queued'))) * 1000 as oldest_queued_age_ms, "
        " coalesce(sum((cost ->> 'model_calls')::bigint) "
        "   filter (where cost ? 'model_calls'), 0) as model_calls, "
        " coalesce(sum((cost ->> 'input_tokens')::bigint) "
        "   filter (where cost ? 'input_tokens'), 0) as input_tokens, "
        " coalesce(sum((cost ->> 'output_tokens')::bigint) "
        "   filter (where cost ? 'output_tokens'), 0) as output_tokens, "
        " coalesce(sum((cost ->> 'usd_estimate')::numeric) "
        "   filter (where cost ? 'usd_estimate'), 0) as usd_estimate "
        "from job where workspace_id = %s and kind = %s",
        (workspace_id, DERIVATIVES),
    ).fetchone()
    assert row is not None
    states = {
        item["state"]: int(item["n"])
        for item in connection.execute(
            "select state, count(*) as n from job "
            "where workspace_id = %s and kind = %s group by state order by state",
            (workspace_id, DERIVATIVES),
        ).fetchall()
    }
    failures = {
        item["failure_class"]: int(item["n"])
        for item in connection.execute(
            "select failure_class, count(*) as n from job "
            "where workspace_id = %s and kind = %s and failure_class is not null "
            "group by failure_class order by failure_class",
            (workspace_id, DERIVATIVES),
        ).fetchall()
    }
    return {
        "depth": {"queued": int(row["queued"]), "running": int(row["running"])},
        "terminal": int(row["terminal"]),
        "states": states,
        "oldest_queued_age_ms": _integer_or_none(row["oldest_queued_age_ms"]),
        "attempts": {"maximum": int(row["max_attempts"] or 0)},
        "duration_ms": {
            "average": _integer_or_none(row["average_duration_ms"]),
            "maximum": _integer_or_none(row["maximum_duration_ms"]),
        },
        "cost": {
            "model_calls": int(row["model_calls"]),
            "input_tokens": int(row["input_tokens"]),
            "output_tokens": int(row["output_tokens"]),
            "usd_estimate": str(row["usd_estimate"]),
        },
        "failure_classes": failures,
    }


def derivative_job_events(
    connection: psycopg.Connection,
    workspace_id: uuid.UUID,
    job_id: uuid.UUID,
) -> list[dict[str, Any]]:
    """The complete delivery replay for one job, or empty for foreign and unknown ids alike."""
    rows = connection.execute(
        "select event_id, job_id, worker_id, event_type, claim_token, attempt, capture_id, "
        "progress_completed, progress_total, duration_ms, cost, failure_class, message, "
        "occurred_at from derivative_job_event "
        "where workspace_id = %s and job_id = %s order by occurred_at, event_id",
        (workspace_id, job_id),
    ).fetchall()
    return [
        {
            key: (
                str(value)
                if isinstance(value, uuid.UUID)
                else value.isoformat()
                if hasattr(value, "isoformat")
                else value
            )
            for key, value in dict(row).items()
            if value is not None
        }
        for row in rows
    ]


def _integer_or_none(value: Any) -> int | None:
    return None if value is None else int(value)

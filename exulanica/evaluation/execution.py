"""Read-only execution provenance for the exact corpus sources under evaluation.

Every duration, attempt, cost, model reference, and reuse count comes from the append-only pipeline
ledger.  Missing provider usage remains missing; this module never estimates it.  Error messages and
host names are hashed because exact replay needs their presence and identity, not private text or a
machine name in an exported evaluation record.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import uuid
from collections import Counter
from collections.abc import Iterable, Mapping
from decimal import Decimal, InvalidOperation
from typing import Any

__all__ = ["execution_snapshot"]


def _digest_text(value: object) -> str | None:
    if value is None:
        return None
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _json_value(value: object) -> object:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).hex()
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    raise TypeError(f"database provenance contains unsupported {type(value).__name__}")


def _rows(cursor: Any) -> list[dict[str, Any]]:
    return [dict(row) for row in cursor.fetchall()]


def _decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def _cost_summary(events: list[dict[str, Any]]) -> dict[str, object]:
    totals = {
        "input_tokens": Decimal(0),
        "output_tokens": Decimal(0),
        "gpu_seconds": Decimal(0),
        "usd_estimate": Decimal(0),
    }
    observed = {key: 0 for key in totals}
    cost_events = 0
    model_events_without_cost = 0
    for event in events:
        cost = event.get("cost")
        if event.get("model_ref") is not None and cost is None:
            model_events_without_cost += 1
        if not isinstance(cost, Mapping):
            continue
        cost_events += 1
        for key in totals:
            amount = _decimal(cost.get(key))
            if amount is not None:
                totals[key] += amount
                observed[key] += 1
    return {
        "cost_events": cost_events,
        "model_events_without_cost": model_events_without_cost,
        "totals": {key: str(total) if observed[key] else None for key, total in totals.items()},
        "observations": observed,
        "rule": "provider or stage reported values only; missing values are not estimated",
    }


def execution_snapshot(
    connection: Any,
    workspace_id: uuid.UUID,
    source_sha256: Iterable[str],
) -> dict[str, object]:
    """Snapshot ledger rows whose capture source is in the frozen corpus source set."""
    sources = sorted(set(source_sha256))
    if not sources:
        raise ValueError("execution provenance requires at least one source digest")
    if any(
        len(value) != 64 or any(char not in "0123456789abcdef" for char in value)
        for value in sources
    ):
        raise ValueError("execution provenance source digests must be lowercase SHA-256")

    run_rows = _rows(
        connection.execute(
            "select pr.run_id, pr.capture_id, pr.trigger, pr.started_at, pr.ended_at, "
            "pr.status, encode(c.blob_sha256, 'hex') as source_sha256 "
            "from pipeline_run pr join capture c on c.capture_id = pr.capture_id "
            "where pr.workspace_id = %s and encode(c.blob_sha256, 'hex') = any(%s) "
            "order by pr.started_at, pr.run_id",
            (workspace_id, sources),
        )
    )
    run_ids = [row["run_id"] for row in run_rows]
    event_rows: list[dict[str, Any]] = []
    if run_ids:
        event_rows = _rows(
            connection.execute(
                "select run_id, seq, parent_event_id, type::text as type, stage_key, "
                "stage_version, model_ref, params_digest, input_artifact_ids, "
                "output_artifact_ids, input_blob_sha256, attempt, max_attempts, error_class, "
                "error_message, started_at, ended_at, duration_ms, cost, host, models_tried, "
                "occurred_at "
                "from pipeline_event where run_id = any(%s::uuid[]) order by run_id, seq",
                (run_ids,),
            )
        )
    artifact_rows = _rows(
        connection.execute(
            "select artifact_id, kind, encode(source_blob_sha256, 'hex') as source_sha256, "
            "stage_key, stage_version, encode(params_digest, 'hex') as params_sha256, "
            "encode(input_digest, 'hex') as input_sha256, idempotency_key, "
            "encode(content_sha256, 'hex') as content_sha256, byte_size, produced_by_event, "
            "needs_repair, purged_at, created_at from artifact where workspace_id = %s "
            "and encode(source_blob_sha256, 'hex') = any(%s) order by artifact_id",
            (workspace_id, sources),
        )
    )
    definition_rows = _rows(
        connection.execute(
            "select stage_key, stage_version, encode(params_digest, 'hex') as params_sha256, "
            "params, model_role, deterministic, output_kind, review_status, registered_at "
            "from stage_definition order by stage_key, stage_version, params_digest"
        )
    )
    migration_rows = _rows(
        connection.execute(
            "select version, encode(checksum, 'hex') as sha256, applied_at "
            "from schema_migrations order by version"
        )
    )

    event_counts = Counter(str(row["type"]) for row in event_rows)
    duration_values = [
        int(row["duration_ms"]) for row in event_rows if row.get("duration_ms") is not None
    ]
    models_answered = sorted(
        {
            json.dumps(row["model_ref"], sort_keys=True, separators=(",", ":"))
            for row in event_rows
            if row.get("model_ref") is not None
        }
    )
    model_stage_keys = {
        str(row["stage_key"]) for row in definition_rows if row.get("model_role") is not None
    }
    missing_model_attempts = [
        {
            "run_id": str(row["run_id"]),
            "seq": int(row["seq"]),
            "stage_key": row["stage_key"],
            "event": row["type"],
        }
        for row in event_rows
        if row.get("stage_key") in model_stage_keys
        and row.get("type") in {"stage_succeeded", "stage_failed"}
        and row.get("models_tried") is None
    ]
    model_ids_tried = sorted(
        {str(model_id) for row in event_rows for model_id in (row.get("models_tried") or [])}
    )

    public_events: list[dict[str, object]] = []
    for row in event_rows:
        public = {key: _json_value(value) for key, value in row.items()}
        public["error_message_sha256"] = _digest_text(row.get("error_message"))
        public["host_sha256"] = _digest_text(row.get("host"))
        public.pop("error_message", None)
        public.pop("host", None)
        public_events.append(public)

    found_sources = {str(row["source_sha256"]) for row in run_rows}
    return {
        "workspace_id": str(workspace_id),
        "source_coverage": {
            "declared": sources,
            "with_pipeline_run": sorted(found_sources),
            "missing_pipeline_run": sorted(set(sources) - found_sources),
            "complete": set(sources) == found_sources,
        },
        "summary": {
            "runs": len(run_rows),
            "events": len(event_rows),
            "event_counts": dict(sorted(event_counts.items())),
            "reuse_events": event_counts["stage_reused"],
            "retry_events": event_counts["retry_scheduled"],
            "duration_ms": {
                "observations": len(duration_values),
                "sum": sum(duration_values),
            },
            "attempts_observed": [
                int(row["attempt"]) for row in event_rows if row.get("attempt") is not None
            ],
            "models_answered": [json.loads(value) for value in models_answered],
            "model_ids_tried": model_ids_tried,
            "model_attempt_provenance_complete": not missing_model_attempts,
            "model_attempt_provenance_missing_events": missing_model_attempts,
            "cost": _cost_summary(event_rows),
        },
        "pipeline_runs": [_json_value(row) for row in run_rows],
        "pipeline_events": public_events,
        "artifacts": [_json_value(row) for row in artifact_rows],
        "stage_definitions": [_json_value(row) for row in definition_rows],
        "applied_migrations": [_json_value(row) for row in migration_rows],
    }

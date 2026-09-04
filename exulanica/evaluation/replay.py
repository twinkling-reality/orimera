"""Clean-database replay for a frozen evaluation bundle.

The owner connection is used only to prove the database is empty, apply forward migrations, and
provision one workspace partition. Corpus processing uses a separate runtime connection that must
be subject to row-level security. A synthetic fixture may opt into an owner connection in tests,
and the resulting gate receipt records that it did not prove runtime isolation.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import pathlib
import uuid
from dataclasses import dataclass
from typing import Any

from exulanica.db import Database, apply_pending, provision_workspace
from exulanica.db.roles import RuntimeRoleUnsafe, assert_runtime_role
from exulanica.evaluation.bundle import AccessPurpose, CorpusBundle, CorpusContractError
from exulanica.evaluation.execution import execution_snapshot
from exulanica.evaluation.provenance import (
    RUN_PROFILE,
    ArchiveReceipt,
    create_archive,
    migration_snapshot,
    model_snapshot,
    pipeline_snapshot,
)
from exulanica.ingest.continuity import run_continuity
from exulanica.ingest.pipeline import PhotoIngestPipeline
from exulanica.ingest.repository import IngestRepository
from exulanica.ingest.vision import VisionModel
from exulanica.store.local import LocalContentAddressedStore

__all__ = [
    "CleanDatabaseError",
    "ReplayError",
    "ReplayReceipt",
    "assert_pristine_database",
    "run_clean_replay",
]


class ReplayError(RuntimeError):
    """A clean replay cannot produce the evidence its record requires."""


class CleanDatabaseError(ReplayError):
    """The owner URL does not identify a new empty evaluation database."""


@dataclass(frozen=True, slots=True)
class ReplayReceipt:
    archive: ArchiveReceipt
    gate_passed: bool
    blockers: tuple[str, ...]


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()


def assert_pristine_database(database: Database) -> dict[str, object]:
    """Prove that an owner URL points at an empty non-administrative database."""
    with database.unscoped() as connection:
        identity = connection.execute(
            "select current_database() as database_name, current_schema() as schema_name, "
            "current_user as role_name, current_setting('server_version') as server_version"
        ).fetchone()
        assert identity is not None
        database_name = str(identity["database_name"])
        if database_name in {"postgres", "template0", "template1"}:
            raise CleanDatabaseError(
                f"refusing administrative database {database_name!r}; "
                "provide a new evaluation database"
            )
        if identity["schema_name"] != "public":
            raise CleanDatabaseError(
                f"clean replay requires current_schema public, got {identity['schema_name']!r}"
            )
        schemas = [
            row["nspname"]
            for row in connection.execute(
                "select nspname from pg_namespace where nspname <> 'information_schema' "
                "and nspname !~ '^pg_' order by nspname"
            ).fetchall()
        ]
        if schemas != ["public"]:
            raise CleanDatabaseError(
                f"database is not new: non-system schemas are {schemas}, expected only public"
            )
        relations = connection.execute(
            "select n.nspname as schema_name, c.relname, c.relkind "
            "from pg_class c join pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' "
            "and c.relkind in ('r','p','v','m','S','f') order by n.nspname, c.relname"
        ).fetchall()
        if relations:
            names = [f"{row['schema_name']}.{row['relname']}" for row in relations[:10]]
            raise CleanDatabaseError(
                f"database is not empty: found {len(relations)} user relations, including {names}"
            )
        extensions = [
            row["extname"]
            for row in connection.execute(
                "select extname from pg_extension order by extname"
            ).fetchall()
        ]
        return {
            "database_name": database_name,
            "schema_name": "public",
            "owner_role": str(identity["role_name"]),
            "server_version": str(identity["server_version"]),
            "initial_user_relations": 0,
            "initial_non_system_schemas": ["public"],
            "initial_extensions": extensions,
        }


def _contract_snapshots(bundle: CorpusBundle) -> dict[str, bytes]:
    return {
        f"inputs/corpus/{relative}": payload
        for relative, payload in bundle.contract_files().items()
    }


def _outcomes(sources: tuple[Any, ...], outcomes: list[Any]) -> list[dict[str, object]]:
    return [
        {
            "item_id": source.item_id,
            "succeeded": outcome.error is None,
            "error_sha256": (
                hashlib.sha256(str(outcome.error).encode()).hexdigest()
                if outcome.error is not None
                else None
            ),
            "stages_run": list(outcome.stages_run),
            "stages_reused": list(outcome.stages_reused),
            "stages_skipped": list(outcome.stages_skipped),
            "model_calls": outcome.model_calls,
        }
        for source, outcome in zip(sources, outcomes, strict=True)
    ]


def _report(record: dict[str, Any]) -> str:
    gate = record["phase_2_exit_gate"]
    lines = [
        "Exulanica clean evaluation replay",
        "",
        f"run id              {record['run_id']}",
        f"corpus              {record['corpus']['id']}",
        f"corpus sha256       {record['corpus']['sha256']}",
        f"split               {record['access']['split']}",
        f"sources             {record['ingest']['sources']}",
        f"first model calls   {record['ingest']['first_model_calls']}",
        f"replay model calls  {record['ingest']['replay_model_calls']}",
        f"phase 2 gate        {'PASS' if gate['passed'] else 'BLOCKED'}",
        "",
    ]
    if gate["blockers"]:
        lines.append("Blockers:")
        lines.extend(f"  - {blocker}" for blocker in gate["blockers"])
    lines.extend(
        [
            "",
            "This report measures replay mechanics only. It contains no product metric",
            "baseline unless metric_baseline_complete is true in record.json.",
        ]
    )
    return "\n".join(lines) + "\n"


def run_clean_replay(
    *,
    bundle: CorpusBundle,
    owner_database: Database,
    runtime_database: Database,
    data_dir: pathlib.Path,
    audit_path: pathlib.Path,
    archive_parent: pathlib.Path,
    repository_state: dict[str, object],
    purpose: AccessPurpose,
    actor: str,
    blind_key: str | None,
    vision: VisionModel | None,
    allow_unsafe_runtime_for_synthetic_test: bool = False,
) -> ReplayReceipt:
    """Run one first pass and one idempotency pass, then archive every replay fact."""
    if audit_path.exists():
        raise ReplayError(f"access audit already exists and will not be appended: {audit_path}")
    if not audit_path.parent.is_dir():
        raise ReplayError(f"access audit parent does not exist: {audit_path.parent}")
    if not archive_parent.is_dir():
        raise ReplayError(f"archive parent does not exist: {archive_parent}")
    if vision is None and not bundle.synthetic:
        raise ReplayError("offline replay is allowed only for an explicitly synthetic fixture")
    database_proof = assert_pristine_database(owner_database)
    migrations_applied = apply_pending(owner_database)
    workspace_id = uuid.uuid4()
    with owner_database.unscoped() as connection:
        provision_workspace(connection, workspace_id)

    runtime_role_enforced = True
    with runtime_database.session(workspace_id) as connection:
        try:
            assert_runtime_role(connection)
        except RuntimeRoleUnsafe:
            if not allow_unsafe_runtime_for_synthetic_test or not bundle.synthetic:
                raise
            runtime_role_enforced = False

    try:
        selected, access = bundle.open_sources(
            purpose,
            audit_path=audit_path,
            actor=actor,
            blind_key=blind_key,
        )
    except CorpusContractError as exc:
        raise ReplayError(str(exc)) from exc

    store = LocalContentAddressedStore(data_dir / "blobs")
    with runtime_database.session(workspace_id) as connection:
        if runtime_role_enforced:
            assert_runtime_role(connection)
        repository = IngestRepository(connection, workspace_id)
        pipeline = PhotoIngestPipeline(repository, store, vision=vision)
        first = [pipeline.ingest_file(source.source_path) for source in selected]
        continuity = run_continuity(repository)
        replay = [pipeline.ingest_file(source.source_path) for source in selected]
        execution = execution_snapshot(
            connection,
            workspace_id,
            (source.source_sha256 for source in selected),
        )

    first_failed = sum(outcome.error is not None for outcome in first)
    replay_failed = sum(outcome.error is not None for outcome in replay)
    replay_model_calls = sum(outcome.model_calls for outcome in replay)
    metric_baseline_complete = False
    blockers: list[str] = []
    if bundle.synthetic:
        blockers.append("the bundle is synthetic and cannot support an OGC-1 baseline")
    if purpose is not AccessPurpose.BLIND_EVALUATION:
        blockers.append("the replay did not use the frozen blind split")
    if not runtime_role_enforced:
        blockers.append("the synthetic test used an owner connection for runtime processing")
    if first_failed or replay_failed:
        blockers.append(f"ingest failures occurred: first={first_failed}, replay={replay_failed}")
    if replay_model_calls:
        blockers.append(f"the idempotency pass made {replay_model_calls} model calls")
    if not execution["source_coverage"]["complete"]:
        blockers.append("not every authorized source has a pipeline run")
    if not metric_baseline_complete:
        blockers.append("the CORPUS.json label layers are not yet wired to all baseline scorers")

    run_id = str(uuid.uuid4())
    generated_at = dt.datetime.now(dt.UTC)
    model, model_bytes = model_snapshot()
    bindings = {"vision": {"model_id": vision.model_id}} if vision is not None else {}
    stages = pipeline_snapshot(bindings)
    record: dict[str, Any] = {
        "profile": RUN_PROFILE,
        "run_id": run_id,
        "harness_version": "2",
        "generated_at": generated_at.isoformat(),
        "repository": repository_state,
        "corpus": {
            "id": bundle.corpus_id,
            "sha256": bundle.corpus_digest,
            "split_manifest_sha256": bundle.split_digest,
            "consent_index_sha256": bundle.consent_digest,
            "synthetic": bundle.synthetic,
        },
        "access": {
            "purpose": purpose.value,
            "split": access.split,
            "actor": access.actor,
            "item_ids": list(access.item_ids),
            "audit_sha256": access.audit_sha256,
        },
        "database": {
            **database_proof,
            "migrations_applied": list(migrations_applied.applied),
            "workspace_id": str(workspace_id),
            "runtime_role_enforced": runtime_role_enforced,
        },
        "ingest": {
            "sources": len(selected),
            "first_model_calls": sum(outcome.model_calls for outcome in first),
            "replay_model_calls": replay_model_calls,
            "first": _outcomes(selected, first),
            "replay": _outcomes(selected, replay),
            "continuity": {
                "scene_groups": len(continuity.scenes.groups),
                "place_proposals": len(continuity.scenes.proposals),
                "identity_proposals": len(continuity.proposals.surfaced),
            },
        },
        "metric_baseline_complete": metric_baseline_complete,
        "execution_summary": execution["summary"],
        "phase_2_exit_gate": {"passed": not blockers, "blockers": blockers},
        "model_manifest": model,
        "pipeline": stages,
        "package_migrations": migration_snapshot(),
    }
    report = _report(record)
    snapshots = {
        **_contract_snapshots(bundle),
        "inputs/model-manifest.json": model_bytes,
        "access/source-access.jsonl": audit_path.read_bytes(),
        "snapshots/database-execution.json": _json_bytes(execution),
        "snapshots/repository.json": _json_bytes(repository_state),
        "snapshots/pipeline.json": _json_bytes(stages),
        "snapshots/model-bindings.json": _json_bytes(model),
        "snapshots/package-migrations.json": _json_bytes(migration_snapshot()),
    }
    archive = create_archive(
        archive_parent,
        run_id=run_id,
        record=record,
        report=report,
        snapshots=snapshots,
        completed_at=generated_at,
    )
    return ReplayReceipt(
        archive=archive,
        gate_passed=not blockers,
        blockers=tuple(blockers),
    )

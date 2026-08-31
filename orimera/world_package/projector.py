"""Transactionally consistent projection from the durable world into WMP v1."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import psycopg
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from psycopg.rows import dict_row

from orimera.world_package.package import (
    MANIFEST_PATH,
    PROFILE_ID,
    PROFILE_VERSION,
    SIGNATURE_PATH,
    PackageError,
    build_manifest,
    canonical_file,
    profile_bytes,
    scan_payload,
    sign_manifest,
)

DEFAULT_WORLD_ID: Final = "atlas:default"
_EXPORT_POLICY: Final = {
    "external_media_references": "digest-only; authorized resolver required",
    "included": [
        "compatible semantic graph",
        "reconstruction descriptors",
        "current topology, layout, placement, and neighborhood",
        "current appearance and interaction policy",
        "pipeline provenance",
        "explicit evaluation state",
        "deletion tombstones",
    ],
    "profile": "orimera-wmp-default-exclusion-v1",
    "raw_payloads": "excluded",
}


@dataclass(frozen=True, slots=True)
class ProjectionResult:
    export_id: uuid.UUID
    output: Path
    merkle_root_sha256: str
    manifest_sha256: str
    signing_public_key_sha256: str
    structure_snapshot_id: uuid.UUID | None
    style_version_id: uuid.UUID | None
    interaction_policy_version_id: uuid.UUID | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "export_id": str(self.export_id),
            "interaction_policy_version_id": _optional_uuid(
                self.interaction_policy_version_id
            ),
            "manifest_sha256": self.manifest_sha256,
            "merkle_root_sha256": self.merkle_root_sha256,
            "output": str(self.output),
            "profile_version": PROFILE_VERSION,
            "signing_public_key_sha256": self.signing_public_key_sha256,
            "structure_snapshot_id": _optional_uuid(self.structure_snapshot_id),
            "style_version_id": _optional_uuid(self.style_version_id),
        }


def project_world_package(
    connection: psycopg.Connection,
    *,
    workspace_id: uuid.UUID,
    actor: uuid.UUID,
    output: Path,
    private_key: Ed25519PrivateKey,
    world_id: str = DEFAULT_WORLD_ID,
    parent_merkle_root_sha256: str | None = None,
    evaluation_reports: Sequence[Path] = (),
    after_snapshot_hook: Callable[[], None] | None = None,
) -> ProjectionResult:
    """Project, sign, receipt, and atomically publish one consistent database snapshot.

    ``after_snapshot_hook`` is a deliberately narrow concurrency test seam.  It runs after the
    first query has established a REPEATABLE READ snapshot and before any component rows are
    read; production callers leave it unset.
    """
    if connection.info.transaction_status.name != "IDLE":
        raise PackageError("package projection requires an idle connection")
    if output.exists():
        raise PackageError(f"output already exists: {output}")
    if parent_merkle_root_sha256 is not None and not _is_sha256(parent_merkle_root_sha256):
        raise PackageError("parent Merkle root must be a lowercase SHA-256 digest")
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    export_id = uuid.uuid4()
    try:
        with connection.transaction():
            connection.execute("set transaction isolation level repeatable read")
            connection.execute(
                "select set_config('orimera.workspace_id', %s, true)", (str(workspace_id),)
            )
            with connection.cursor(row_factory=dict_row) as cursor:
                pointers = _current_pointers(cursor, world_id)
                if after_snapshot_hook is not None:
                    after_snapshot_hook()
                components = _project_components(
                    cursor,
                    world_id,
                    pointers,
                    evaluation_reports=evaluation_reports,
                    parent_merkle_root_sha256=parent_merkle_root_sha256,
                )
                files = _crate_files(components)
                for path, data in files.items():
                    if path.endswith(".json"):
                        scan_payload(path, json.loads(data))
                    _write(staging, path, data)
                manifest = build_manifest(files)
                manifest_bytes = canonical_file(manifest)
                signature = sign_manifest(manifest_bytes, private_key)
                signature_bytes = canonical_file(signature)
                _write(staging, MANIFEST_PATH, manifest_bytes)
                _write(staging, SIGNATURE_PATH, signature_bytes)
                public_raw = private_key.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw
                )
                public_fingerprint = hashlib.sha256(public_raw).hexdigest()
                manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
                cursor.execute(
                    "insert into world_package_export "
                    "(export_id,workspace_id,world_id,profile_version,merkle_root_sha256,"
                    "manifest_sha256,parent_merkle_root_sha256,structure_snapshot_id,"
                    "style_version_id,interaction_policy_version_id,signature_algorithm,"
                    "signing_public_key_sha256,export_policy,actor) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'Ed25519',%s,%s,%s)",
                    (
                        export_id,
                        workspace_id,
                        world_id,
                        PROFILE_VERSION,
                        manifest["merkle_root_sha256"],
                        manifest_sha256,
                        parent_merkle_root_sha256,
                        pointers["structure_snapshot_id"],
                        pointers["style_version_id"],
                        pointers["interaction_policy_version_id"],
                        public_fingerprint,
                        psycopg.types.json.Jsonb(_EXPORT_POLICY),
                        actor,
                    ),
                )
                os.rename(staging, output)
                published = True
        return ProjectionResult(
            export_id=export_id,
            output=output,
            merkle_root_sha256=manifest["merkle_root_sha256"],
            manifest_sha256=manifest_sha256,
            signing_public_key_sha256=public_fingerprint,
            structure_snapshot_id=pointers["structure_snapshot_id"],
            style_version_id=pointers["style_version_id"],
            interaction_policy_version_id=pointers["interaction_policy_version_id"],
        )
    except Exception:
        if published and output.exists():
            shutil.rmtree(output)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _current_pointers(cursor: psycopg.Cursor, world_id: str) -> dict[str, uuid.UUID | None]:
    structure = cursor.execute(
        "select current_snapshot_id from world_structure_state where world_id=%s", (world_id,)
    ).fetchone()
    style = cursor.execute(
        "select current_style_version_id from world_style_state where world_id=%s", (world_id,)
    ).fetchone()
    interaction = cursor.execute(
        "select current_version_id from world_interaction_policy_state where world_id=%s",
        (world_id,),
    ).fetchone()
    return {
        "interaction_policy_version_id": (
            interaction["current_version_id"] if interaction is not None else None
        ),
        "structure_snapshot_id": (
            structure["current_snapshot_id"] if structure is not None else None
        ),
        "style_version_id": style["current_style_version_id"] if style is not None else None,
    }


def _project_components(
    cursor: psycopg.Cursor,
    world_id: str,
    pointers: Mapping[str, uuid.UUID | None],
    *,
    evaluation_reports: Sequence[Path],
    parent_merkle_root_sha256: str | None,
) -> dict[str, Any]:
    captures = cursor.execute(
        "select c.capture_id,c.blob_sha256,c.started_at,c.created_at,b.byte_size,b.media_type,"
        "b.ni_uri,b.purged_at from capture c join blob b using(blob_sha256) "
        "where c.deleted_at is null order by c.capture_id"
    ).fetchall()
    spans = cursor.execute(
        "select s.span_id,s.blob_sha256,s.track_key,s.t_start_ns,s.t_end_ns,s.modality,"
        "s.region,s.span_digest from evidence_span s where exists "
        "(select 1 from capture c where c.blob_sha256=s.blob_sha256 and c.deleted_at is null) "
        "order by s.span_id"
    ).fetchall()
    occurrences = cursor.execute(
        "select o.occurrence_id,o.capture_id,o.class,o.primary_span_id,o.span_ids,o.presence,"
        "o.detector_version,o.quality,o.identity_key from occurrence o "
        "join capture c using(capture_id) "
        "where c.deleted_at is null order by o.occurrence_id"
    ).fetchall()
    entities = cursor.execute(
        "select entity_id,class,display_name,merged_into,created_at from entity "
        "where deleted_at is null order by entity_id"
    ).fetchall()
    links = cursor.execute(
        "select l.link_id,l.occurrence_id,l.entity_id,l.state,l.method,l.basis_digest,l.decided_at "
        "from entity_link l join entity e using(entity_id) join occurrence o using(occurrence_id) "
        "join capture c on c.capture_id=o.capture_id "
        "where e.deleted_at is null and c.deleted_at is null order by l.link_id"
    ).fetchall()
    assertions = cursor.execute(
        "select a.assertion_id,a.kind,p.key as predicate,a.subject_ref,a.object_ref,a.object_value,"
        "a.valid_time,a.asserted_at,a.support_span_ids,a.external_source,a.status,a.supersedes "
        "from assertion a join predicate p using(predicate_id) where a.status='active' "
        "and not exists (select 1 from tombstone t where t.scope='assertion' "
        "and t.assertion_id=a.assertion_id and t.effective_at<=now()) order by a.assertion_id"
    ).fetchall()
    artifacts = cursor.execute(
        "select a.artifact_id,a.kind,a.stage_key,a.stage_version,a.params_digest,a.input_digest,"
        "a.content_sha256,a.byte_size,a.superseded_by,a.purged_at,a.needs_repair "
        "from artifact a where exists (select 1 from capture c "
        "where c.blob_sha256=a.source_blob_sha256 and c.deleted_at is null) "
        "order by a.artifact_id"
    ).fetchall()

    span_ids = {row["span_id"]: _urn("span", row["span_id"]) for row in spans}
    capture_ids = {row["capture_id"]: _urn("capture", row["capture_id"]) for row in captures}
    occurrence_ids = {
        row["occurrence_id"]: _urn("occurrence", row["occurrence_id"]) for row in occurrences
    }
    entity_ids = {row["entity_id"]: _urn("entity", row["entity_id"]) for row in entities}
    artifact_ids = {
        row["artifact_id"]: _urn("artifact", row["artifact_id"]) for row in artifacts
    }

    graph = {
        "assertions": [
            {
                "assertion_id": _urn("assertion", row["assertion_id"]),
                "asserted_at": row["asserted_at"],
                "external_source": row["external_source"],
                "kind": str(row["kind"]),
                "object_ref": _reference(row["object_ref"]),
                "object_value": row["object_value"],
                "predicate": row["predicate"],
                "status": str(row["status"]),
                "subject_ref": _reference(row["subject_ref"]),
                "support_span_ids": [
                    span_ids.get(value, _urn("span", value))
                    for value in row["support_span_ids"]
                ],
                "supersedes": _optional_urn("assertion", row["supersedes"]),
                "valid_time": row["valid_time"],
            }
            for row in assertions
        ],
        "captures": [
            {
                "capture_id": capture_ids[row["capture_id"]],
                "content_sha256": row["blob_sha256"],
                "created_at": row["created_at"],
                "started_at": row["started_at"],
            }
            for row in captures
        ],
        "entities": [
            {
                "class": str(row["class"]),
                "display_name": row["display_name"],
                "entity_id": entity_ids[row["entity_id"]],
                "merged_into": _mapped_or_urn(entity_ids, "entity", row["merged_into"]),
            }
            for row in entities
        ],
        "links": [
            {
                "basis_sha256": row["basis_digest"],
                "decided_at": row["decided_at"],
                "entity_id": entity_ids.get(row["entity_id"], _urn("entity", row["entity_id"])),
                "link_id": _urn("link", row["link_id"]),
                "method": row["method"],
                "occurrence_id": occurrence_ids.get(
                    row["occurrence_id"], _urn("occurrence", row["occurrence_id"])
                ),
                "state": str(row["state"]),
            }
            for row in links
        ],
        "occurrences": [
            {
                "capture_id": capture_ids.get(
                    row["capture_id"], _urn("capture", row["capture_id"])
                ),
                "class": str(row["class"]),
                "detector_version": row["detector_version"],
                "evidence_identity_sha256": row["identity_key"],
                "occurrence_id": occurrence_ids[row["occurrence_id"]],
                "presence": row["presence"],
                "primary_span_id": span_ids.get(
                    row["primary_span_id"], _urn("span", row["primary_span_id"])
                ),
                "quality": row["quality"],
                "span_ids": [span_ids.get(value, _urn("span", value)) for value in row["span_ids"]],
            }
            for row in occurrences
        ],
        "profile": "orimera-semantic-graph-projection-v1",
    }
    evidence = {
        "items": [
            {
                "address": {
                    "content_sha256": row["blob_sha256"],
                    "end_ns": row["t_end_ns"],
                    "start_ns": row["t_start_ns"],
                    "track_key": row["track_key"],
                },
                "modality": row["modality"],
                "region": row["region"],
                "span_digest_sha256": row["span_digest"],
                "span_id": span_ids[row["span_id"]],
            }
            for row in spans
        ],
        "profile": "orimera-evidence-descriptors-v1",
    }
    reconstruction = {
        "items": [
            {
                "artifact_id": artifact_ids[row["artifact_id"]],
                "byte_size": row["byte_size"],
                "content_sha256": row["content_sha256"],
                "input_sha256": row["input_digest"],
                "integrity": "needs-repair" if row["needs_repair"] else "recorded",
                "kind": row["kind"],
                "params_sha256": row["params_digest"],
                "stage": {"key": row["stage_key"], "version": row["stage_version"]},
                "state": (
                    "purged"
                    if row["purged_at"] is not None
                    else "unavailable"
                    if row["content_sha256"] is None
                    else "available-by-authorized-digest-resolver"
                ),
                "superseded_by": _mapped_or_urn(
                    artifact_ids, "artifact", row["superseded_by"]
                ),
            }
            for row in artifacts
        ],
        "payload_bytes": "excluded",
        "profile": "orimera-reconstruction-descriptors-v1",
        "quality_measurements": {
            "reason": (
                "quality payload bytes are excluded; recorded claims and artifact descriptors "
                "remain available"
            ),
            "state": "descriptors-only",
        },
        "rung_claims": [
            {
                "assertion_id": assertion["assertion_id"],
                "evidence_support": assertion["support_span_ids"],
                "value": assertion["object_value"],
            }
            for assertion in graph["assertions"]
            if assertion["predicate"] == "reconstruction_rung_is"
        ],
    }
    structure, world_sections = _structure(cursor, world_id, pointers["structure_snapshot_id"])
    style = _style(cursor, world_id, pointers["style_version_id"])
    interaction = _interaction(cursor, world_id, pointers["interaction_policy_version_id"])
    provenance = _provenance(cursor, capture_ids, artifact_ids)
    evaluation = _evaluation(evaluation_reports)
    deletion = _deletion(cursor)
    fetch = {
        "items": [
            {
                "authorization": "not carried in package",
                "byte_size": row["byte_size"],
                "content_sha256": row["blob_sha256"],
                "media_type": row["media_type"],
                "ni_uri": row["ni_uri"],
                "retrieval": "requires an authorized content-addressed resolver",
                "state": "purged" if row["purged_at"] is not None else "externally-held",
            }
            for row in captures
        ],
        "profile": "orimera-external-fetch-reference-v1",
    }
    package_provenance = {
        "export_policy": _EXPORT_POLICY,
        "parent_merkle_root_sha256": parent_merkle_root_sha256,
        "profile": "orimera-package-lineage-v1",
        "snapshot_consistency": "PostgreSQL REPEATABLE READ",
    }
    policy = {
        "authorization": {
            "claim": "not carried in package",
            "meaning": (
                "The signature proves package bytes and key possession, not that the signer was "
                "authorized to export them."
            ),
        },
        "consent": {
            "records": "excluded",
            "state": "must be enforced by the source system before projection",
        },
        "export": _EXPORT_POLICY,
        "generated_content": {
            "declaration": "pipeline provenance identifies model-backed events when recorded",
            "present": any(item["model_ref"] is not None for item in provenance["items"]),
        },
        "profile": "orimera-export-policy-and-content-declaration-v1",
    }
    return {
        "appearance/style.json": style,
        "deletion/tombstones.json": deletion,
        "evaluation/results.json": evaluation,
        "evidence/descriptors.json": evidence,
        "external/fetch.json": fetch,
        "interaction/policy.json": interaction,
        "memory/graph.json": graph,
        "policy/export.json": policy,
        "provenance/events.json": provenance,
        "provenance/package.json": package_provenance,
        "reconstruction/artifacts.json": reconstruction,
        "world/structure.json": structure,
        **world_sections,
    }


def _structure(
    cursor: psycopg.Cursor, world_id: str, snapshot_id: uuid.UUID | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    if snapshot_id is None:
        unavailable = {
            "profile": "orimera-spatial-authority-projection-v1",
            "reason": "no current durable spatial snapshot",
            "state": "unavailable",
        }
        return unavailable, {
            path: {"reason": unavailable["reason"], "state": "unavailable"}
            for path in (
                "world/layout.json",
                "world/neighborhood.json",
                "world/placement.json",
                "world/topology.json",
            )
        }
    row = cursor.execute(
        "select snapshot_id,revision,parent_snapshot_id,graph_sha256,reconstruction_sha256,"
        "topology_sha256,layout_sha256,placement_sha256,neighborhood_sha256,snapshot_sha256,"
        "composer_key,composer_version,topology,layout,placement,neighborhood,package_projection "
        "from world_structure_snapshot where world_id=%s and snapshot_id=%s",
        (world_id, snapshot_id),
    ).fetchone()
    if row is None:
        raise PackageError("current structure pointer does not resolve inside the snapshot")
    invalidated = cursor.execute(
        "select count(*) as n from world_structure_invalidation "
        "where world_id=%s and snapshot_id=%s",
        (world_id, snapshot_id),
    ).fetchone()["n"]
    structure = {
        "composer": {"key": row["composer_key"], "version": row["composer_version"]},
        "digests": {
            "graph_sha256": row["graph_sha256"],
            "layout_sha256": row["layout_sha256"],
            "neighborhood_sha256": row["neighborhood_sha256"],
            "placement_sha256": row["placement_sha256"],
            "reconstruction_sha256": row["reconstruction_sha256"],
            "snapshot_sha256": row["snapshot_sha256"],
            "topology_sha256": row["topology_sha256"],
        },
        "invalidated": invalidated > 0,
        "lineage": {
            "parent_snapshot_id": _optional_urn("structure", row["parent_snapshot_id"]),
            "revision": row["revision"],
            "snapshot_id": _urn("structure", row["snapshot_id"]),
        },
        "package_projection": _redact_snapshot_ids(row["package_projection"]),
        "profile": "orimera-spatial-authority-projection-v1",
        "state": "current-invalidated" if invalidated else "current",
    }
    return structure, {
        "world/layout.json": row["layout"],
        "world/neighborhood.json": row["neighborhood"],
        "world/placement.json": row["placement"],
        "world/topology.json": row["topology"],
    }


def _style(cursor: psycopg.Cursor, world_id: str, version_id: uuid.UUID | None) -> dict[str, Any]:
    if version_id is None:
        return {
            "profile": "orimera-adaptive-style-projection-v1",
            "reason": "no current reviewed style version",
            "state": "unavailable",
        }
    row = cursor.execute(
        "select version_id,revision,parent_version_id,topology_digest,global_profile_id,"
        "global_profile_version,global_parameters,rollback_target_version_id,origin,"
        "origin_reference from world_style_version where world_id=%s and version_id=%s",
        (world_id, version_id),
    ).fetchone()
    regions = cursor.execute(
        "select region_id,profile_id,profile_version,parameters from world_region_style_version "
        "where world_id=%s and version_id=%s order by region_id",
        (world_id, version_id),
    ).fetchall()
    registry = cursor.execute(
        "select r.profile_id,r.profile_version,r.compatibility_key,r.status,"
        "r.fallback_profile_id,r.fallback_profile_version,p.parameter_key,p.capability_key,"
        "p.capability_version,p.minimum_value,p.maximum_value,p.step_value,p.default_value,"
        "p.choice_values from world_art_profile_registry r "
        "left join world_art_profile_parameter p using(profile_id,profile_version) "
        "order by r.profile_id,r.profile_version,p.parameter_key"
    ).fetchall()
    if row is None:
        raise PackageError("current style pointer does not resolve inside the snapshot")
    return {
        "global": {
            "parameters": row["global_parameters"],
            "profile_id": row["global_profile_id"],
            "profile_version": row["global_profile_version"],
        },
        "lineage": {
            "parent_version_id": _optional_urn("style", row["parent_version_id"]),
            "revision": row["revision"],
            "rollback_target_version_id": _optional_urn(
                "style", row["rollback_target_version_id"]
            ),
            "version_id": _urn("style", row["version_id"]),
        },
        "origin": row["origin"],
        "origin_reference": row["origin_reference"],
        "profile": "orimera-adaptive-style-projection-v1",
        "registry": [dict(value) for value in registry],
        "regions": [dict(region) for region in regions],
        "state": "current",
        "topology_sha256": row["topology_digest"],
    }


def _interaction(
    cursor: psycopg.Cursor, world_id: str, version_id: uuid.UUID | None
) -> dict[str, Any]:
    if version_id is None:
        return {
            "profile": "orimera-interaction-policy-projection-v1",
            "reason": "no current reviewed interaction policy",
            "state": "unavailable",
        }
    row = cursor.execute(
        "select version_id,revision,parent_version_id,parameters,policy_sha256,"
        "rollback_target_version_id,origin,origin_reference from world_interaction_policy_version "
        "where world_id=%s and version_id=%s",
        (world_id, version_id),
    ).fetchone()
    if row is None:
        raise PackageError("current interaction pointer does not resolve inside the snapshot")
    registry = cursor.execute(
        "select capability_key,capability_version,category,value_kind,minimum_value,"
        "maximum_value,choice_values,default_value,description "
        "from interaction_capability_registry order by capability_key,capability_version"
    ).fetchall()
    return {
        "lineage": {
            "parent_version_id": _optional_urn("interaction", row["parent_version_id"]),
            "revision": row["revision"],
            "rollback_target_version_id": _optional_urn(
                "interaction", row["rollback_target_version_id"]
            ),
            "version_id": _urn("interaction", row["version_id"]),
        },
        "origin": row["origin"],
        "origin_reference": row["origin_reference"],
        "parameters": row["parameters"],
        "policy_sha256": row["policy_sha256"],
        "profile": "orimera-interaction-policy-projection-v1",
        "registry": [dict(value) for value in registry],
        "state": "current",
    }


def _provenance(
    cursor: psycopg.Cursor,
    capture_ids: Mapping[uuid.UUID, str],
    artifact_ids: Mapping[uuid.UUID, str],
) -> dict[str, Any]:
    if not capture_ids:
        return {"items": [], "profile": "orimera-pipeline-ledger-projection-v1"}
    rows = cursor.execute(
        "select e.event_id,e.run_id,e.seq,e.parent_event_id,e.type,e.stage_key,e.stage_version,"
        "e.model_ref,e.models_tried,e.params_digest,e.input_artifact_ids,e.output_artifact_ids,"
        "e.attempt,e.max_attempts,e.error_class,e.started_at,e.ended_at,e.duration_ms,e.cost,"
        "e.occurred_at,r.capture_id,r.trigger,r.status as run_status "
        "from pipeline_event e join pipeline_run r using(run_id) "
        "where r.capture_id=any(%s) order by e.run_id,e.seq",
        (list(capture_ids),),
    ).fetchall()
    return {
        "items": [
            {
                "attempt": row["attempt"],
                "capture_id": capture_ids[row["capture_id"]],
                "cost": row["cost"],
                "duration_ms": row["duration_ms"],
                "ended_at": row["ended_at"],
                "error_class": row["error_class"],
                "event_id": _urn("pipeline-event", row["event_id"]),
                "input_artifact_ids": [
                    artifact_ids.get(value, _urn("artifact", value))
                    for value in row["input_artifact_ids"]
                ],
                "max_attempts": row["max_attempts"],
                "model_ref": row["model_ref"],
                "models_tried": row["models_tried"],
                "occurred_at": row["occurred_at"],
                "output_artifact_ids": [
                    artifact_ids.get(value, _urn("artifact", value))
                    for value in row["output_artifact_ids"]
                ],
                "params_sha256": row["params_digest"],
                "parent_event_id": _optional_urn("pipeline-event", row["parent_event_id"]),
                "run_id": _urn("pipeline-run", row["run_id"]),
                "run_status": row["run_status"],
                "sequence": row["seq"],
                "stage": {"key": row["stage_key"], "version": row["stage_version"]},
                "started_at": row["started_at"],
                "trigger": row["trigger"],
                "type": str(row["type"]),
            }
            for row in rows
        ],
        "omitted": ["host", "error message", "artifact payloads"],
        "profile": "orimera-pipeline-ledger-projection-v1",
    }


def _evaluation(paths: Sequence[Path]) -> dict[str, Any]:
    reports: list[dict[str, Any]] = []
    for index, path in enumerate(paths):
        if path.is_symlink() or not path.is_file():
            raise PackageError(f"evaluation report is not a regular file: {path}")
        data = path.read_bytes()
        try:
            report = json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PackageError(f"evaluation report is not UTF-8 JSON: {path}") from error
        scan_payload(f"evaluation/input-{index}.json", report)
        reports.append(
            {
                "input_sha256": hashlib.sha256(data).hexdigest(),
                "report": report,
                "report_id": f"evaluation-report:{index}",
            }
        )
    return {
        "items": reports,
        "profile": "orimera-evaluation-report-projection-v1",
        "state": "included" if reports else "unavailable",
        "unavailable_reason": None if reports else "no explicit evaluation report was supplied",
    }


def _deletion(cursor: psycopg.Cursor) -> dict[str, Any]:
    rows = cursor.execute(
        "select tombstone_id,scope,capture_id,track_key,interval_ns,entity_id,assertion_id,"
        "blocklist_hash,requested_at,effective_at,purge_completed_at from tombstone "
        "order by effective_at,tombstone_id"
    ).fetchall()
    return {
        "items": [
            {
                "blocklist_hash": row["blocklist_hash"],
                "effective_at": row["effective_at"],
                "interval": row["interval_ns"],
                "purge_state": "complete" if row["purge_completed_at"] is not None else "pending",
                "requested_at": row["requested_at"],
                "scope": str(row["scope"]),
                "target": {
                    "assertion_id": _optional_urn("assertion", row["assertion_id"]),
                    "capture_id": _optional_urn("capture", row["capture_id"]),
                    "entity_id": _optional_urn("entity", row["entity_id"]),
                    "track_key": row["track_key"],
                },
                "tombstone_id": _urn("tombstone", row["tombstone_id"]),
            }
            for row in rows
        ],
        "omitted": ["deletion rationale", "requesting actor"],
        "profile": "orimera-deletion-tombstones-v1",
    }


def _crate_files(components: Mapping[str, Any]) -> dict[str, bytes]:
    files = {path: canonical_file(value) for path, value in components.items()}
    files["wmp/profile.json"] = profile_bytes()
    graph = [
        {
            "@id": "ro-crate-metadata.json",
            "@type": "CreativeWork",
            "about": {"@id": "./"},
            "conformsTo": {"@id": "https://w3id.org/ro/crate/1.2"},
        },
        {
            "@id": "./",
            "@type": "Dataset",
            "conformsTo": {"@id": PROFILE_ID},
            "description": (
                "A signed, privacy-bounded projection of compatible Orimera world memory state."
            ),
            "hasPart": [{"@id": path} for path in sorted(files)],
            "name": "Orimera World Memory Package",
        },
        {
            "@id": PROFILE_ID,
            "@type": ["CreativeWork", "Profile"],
            "description": "Versioned requirements for World Memory Package 1.0.",
            "name": "Orimera World Memory Package Profile 1.0",
            "version": PROFILE_VERSION,
        },
        {
            "@id": "#responsible-ai-boundary",
            "@type": "Dataset",
            "about": {"@id": "./"},
            "citeAs": "Orimera World Memory Package",
            "http://mlcommons.org/croissant/isLiveDataset": False,
            "http://purl.org/dc/terms/conformsTo": [
                "http://mlcommons.org/croissant/1.0",
                "http://mlcommons.org/croissant/RAI/1.0",
            ],
            "description": (
                "A Croissant 1.0 and RAI 1.0 compatibility node for the package privacy boundary."
            ),
            "license": "Apache-2.0",
            "name": "Responsible AI and privacy boundary",
            "http://mlcommons.org/croissant/RAI/dataLimitations": [
                "Raw media and sensitive runtime material are excluded by default.",
                "A package signature proves integrity, not export authorization.",
            ],
            "http://mlcommons.org/croissant/RAI/personalSensitiveInformation": (
                "Compatible world metadata may describe personal memories; authorization remains "
                "external to this portable package."
            ),
            "url": "https://orimera.local/profiles/world-memory-package/1.0",
            "version": PROFILE_VERSION,
        },
        *[
            {
                "@id": path,
                "@type": "File",
                "encodingFormat": (
                    "application/ld+json"
                    if path == "wmp/profile.json"
                    else "application/json"
                ),
                "name": path,
                "sha256": hashlib.sha256(files[path]).hexdigest(),
            }
            for path in sorted(files)
        ],
    ]
    files["ro-crate-metadata.json"] = canonical_file(
        {"@context": "https://w3id.org/ro/crate/1.2/context", "@graph": graph}
    )
    return files


def _write(root: Path, relative: str, data: bytes) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _urn(kind: str, value: Any) -> str:
    digest = hashlib.sha256(f"{kind}:{value}".encode()).hexdigest()
    return f"urn:orimera:wmp:{kind}:{digest}"


def _optional_urn(kind: str, value: Any) -> str | None:
    return None if value is None else _urn(kind, value)


def _optional_uuid(value: uuid.UUID | None) -> str | None:
    return None if value is None else str(value)


def _mapped_or_urn(values: Mapping[Any, str], kind: str, value: Any) -> str | None:
    return None if value is None else values.get(value, _urn(kind, value))


def _reference(value: Any) -> Any:
    if value is None or not isinstance(value, Mapping):
        return value
    result = dict(value)
    ref_type = result.get("type")
    ref_id = result.get("id")
    if isinstance(ref_type, str) and ref_id is not None:
        result["id"] = _urn(ref_type, ref_id)
    return result


def _redact_snapshot_ids(value: Any) -> Any:
    if not isinstance(value, Mapping):
        return value
    result = dict(value)
    for key in ("snapshot_id", "parent_snapshot_id"):
        if result.get(key) is not None:
            result[key] = _urn("structure", result[key])
    return result


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)

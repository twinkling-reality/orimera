"""What a stage produced, under the identity key that says it is the same output.

``idempotency_key`` is what the output should be, computed before the stage runs.
``content_sha256`` is what it turned out to be. They are separate columns because a
deterministic stage that disagrees with itself is a fact worth recording rather than absorbing.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from orimera.db.guards import terminal_if_tombstoned
from orimera.evidence.blob import BlobId
from orimera.ingest.spine.scope import WorkspaceScope

__all__ = ["ArtifactRow", "find", "insert", "mark_needs_repair"]


@dataclass(frozen=True, slots=True)
class ArtifactRow:
    artifact_id: uuid.UUID
    kind: str
    stage_key: str
    stage_version: int
    idempotency_key: str
    content_sha256: bytes | None
    storage_key: str | None
    byte_size: int | None


def find(scope: WorkspaceScope, idempotency_key: str) -> ArtifactRow | None:
    """The live artifact under this identity key, or None. Purged rows are not live."""
    row = scope.connection.execute(
        "select artifact_id, kind, stage_key, stage_version, idempotency_key, "
        "content_sha256, storage_key, byte_size from artifact "
        "where workspace_id = %s and idempotency_key = %s and purged_at is null",
        (scope.workspace_id, idempotency_key),
    ).fetchone()
    if row is None:
        return None
    return ArtifactRow(
        artifact_id=row["artifact_id"],
        kind=row["kind"],
        stage_key=row["stage_key"],
        stage_version=row["stage_version"],
        idempotency_key=row["idempotency_key"],
        content_sha256=bytes(row["content_sha256"]) if row["content_sha256"] else None,
        storage_key=row["storage_key"],
        byte_size=row["byte_size"],
    )


def insert(
    scope: WorkspaceScope,
    *,
    artifact_id: uuid.UUID,
    kind: str,
    source_blob: BlobId,
    stage_key: str,
    stage_version: int,
    params_digest: bytes,
    input_digest: bytes,
    idempotency_key: str,
    content_sha256: bytes,
    storage_key: str,
    byte_size: int,
    produced_by_event: uuid.UUID | None,
) -> bool:
    """Insert a derivative. Returns False when another worker already produced it.

    Never an update. A new ``stage_version`` produces a new row and marks the old one superseded,
    so old citations, old anchor resolutions and old Assembly Replays stay intact.
    """
    # TERMINAL, like every other write the tombstone guards cover. Migration 0011 refuses a
    # derivative of tombstoned bytes, and without this translation the refusal surfaces as an
    # ordinary integrity error: the run is recorded as FAILED, and a failed run is one a worker
    # retries, which is an unbounded loop against a photograph the user deleted.
    with terminal_if_tombstoned():
        cursor = scope.connection.execute(
            "insert into artifact (artifact_id, workspace_id, kind, source_blob_sha256, "
            "stage_key, stage_version, params_digest, input_digest, idempotency_key, "
            "content_sha256, storage_key, byte_size, produced_by_event) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "on conflict (workspace_id, idempotency_key) do nothing",
            (
                artifact_id,
                scope.workspace_id,
                kind,
                source_blob.digest,
                stage_key,
                stage_version,
                params_digest,
                input_digest,
                idempotency_key,
                content_sha256,
                storage_key,
                byte_size,
                produced_by_event,
            ),
        )
    return cursor.rowcount > 0


def mark_needs_repair(scope: WorkspaceScope, artifact_id: uuid.UUID) -> None:
    """Flag an artifact whose bytes are gone and cannot be reproduced.

    Set when a recompute of a stage declared deterministic does not reproduce the stored content
    hash *and* the stored bytes are absent. The row is not rewritten to point at the new bytes:
    the identity key names the old content, and quietly redefining what it names would make every
    citation and replay that used it wrong without saying so.
    """
    scope.connection.execute(
        "update artifact set needs_repair = true where workspace_id = %s and artifact_id = %s",
        (scope.workspace_id, artifact_id),
    )

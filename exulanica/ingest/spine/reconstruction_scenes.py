"""The members of the set a reconstruction was run over.

This module reads ``reconstruction_scene_member`` and its member captures as one table-shaped
question. The result includes deleted captures deliberately: deletion is enforced by the write
guard on the assertion, and filtering a member here would silently turn a claim about N
photographs into one about the survivors.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from exulanica.evidence.blob import BlobId
from exulanica.ingest.spine.scope import WorkspaceScope

__all__ = ["ReconstructionSceneMemberRow", "insert_completed", "members"]


@dataclass(frozen=True, slots=True)
class ReconstructionSceneMemberRow:
    capture_id: uuid.UUID
    ordinal: int
    registered: bool | None
    blob_id: BlobId


def insert_completed(
    scope: WorkspaceScope,
    *,
    scene_id: uuid.UUID,
    member_digest: bytes,
    scene_members: list[tuple[uuid.UUID, bool]],
    job_id: uuid.UUID | None = None,
) -> bool:
    """Record one completed scene and its registration outcomes atomically.

    Returns True for the process that inserted it. A retry of the exact same result returns
    False. Any disagreement in digest, presentation order or registration is refused instead of
    being treated as reuse, because the scene tables are append-only and cannot be corrected by
    an update later.
    """
    if not scene_members:
        raise ValueError("a completed reconstruction scene needs at least one member")
    capture_ids = [capture_id for capture_id, _registered in scene_members]
    if len(set(capture_ids)) != len(capture_ids):
        raise ValueError("a completed reconstruction scene cannot repeat a member")
    with scope.connection.transaction():
        cursor = scope.connection.execute(
            "insert into reconstruction_scene (scene_id, workspace_id, member_digest) "
            "values (%s, %s, %s) on conflict (workspace_id, scene_id) do nothing",
            (scene_id, scope.workspace_id, member_digest),
        )
        inserted = cursor.rowcount > 0
        if inserted:
            with scope.connection.cursor() as member_cursor:
                member_cursor.executemany(
                    "insert into reconstruction_scene_member "
                    "(workspace_id, scene_id, capture_id, ordinal, registered) "
                    "values (%s, %s, %s, %s, %s)",
                    [
                        (scope.workspace_id, scene_id, capture_id, ordinal, registered)
                        for ordinal, (capture_id, registered) in enumerate(scene_members)
                    ],
                )

        scene = scope.connection.execute(
            "select member_digest from reconstruction_scene "
            "where workspace_id = %s and scene_id = %s",
            (scope.workspace_id, scene_id),
        ).fetchone()
        rows = scope.connection.execute(
            "select capture_id, registered from reconstruction_scene_member "
            "where workspace_id = %s and scene_id = %s order by ordinal, capture_id",
            (scope.workspace_id, scene_id),
        ).fetchall()
        actual_members = [(row["capture_id"], bool(row["registered"])) for row in rows]
        if (
            scene is None
            or bytes(scene["member_digest"]) != member_digest
            or [capture_id for capture_id, _registered in actual_members] != capture_ids
            or (job_id is None and actual_members != scene_members)
        ):
            raise ValueError("an existing reconstruction scene disagrees with the completed result")
        if job_id is not None:
            with scope.connection.cursor() as build_cursor:
                build_cursor.executemany(
                    "insert into reconstruction_scene_build_member "
                    "(workspace_id,job_id,capture_id,ordinal,registered) "
                    "values (%s,%s,%s,%s,%s) on conflict do nothing",
                    [
                        (scope.workspace_id, job_id, capture_id, ordinal, registered)
                        for ordinal, (capture_id, registered) in enumerate(scene_members)
                    ],
                )
            build_rows = scope.connection.execute(
                "select capture_id,registered from reconstruction_scene_build_member "
                "where workspace_id=%s and job_id=%s order by ordinal,capture_id",
                (scope.workspace_id, job_id),
            ).fetchall()
            build_members = [(row["capture_id"], bool(row["registered"])) for row in build_rows]
            if build_members != scene_members:
                raise ValueError(
                    "an existing reconstruction build disagrees with the completed result"
                )
    return inserted


def members(
    scope: WorkspaceScope, scene_id: uuid.UUID, *, job_id: uuid.UUID | None = None
) -> list[ReconstructionSceneMemberRow]:
    """Every member in presentation order, including its registration outcome."""
    if job_id is None:
        rows = scope.connection.execute(
            "select m.capture_id,m.ordinal,m.registered,c.blob_sha256 "
            "from reconstruction_scene_member m join capture c "
            "on c.workspace_id=m.workspace_id and c.capture_id=m.capture_id "
            "where m.workspace_id=%s and m.scene_id=%s order by m.ordinal,m.capture_id",
            (scope.workspace_id, scene_id),
        ).fetchall()
    else:
        rows = scope.connection.execute(
            "select m.capture_id,m.ordinal,m.registered,c.blob_sha256 "
            "from reconstruction_scene_build_member m join reconstruction_scene_job j "
            "on j.workspace_id=m.workspace_id and j.job_id=m.job_id join capture c "
            "on c.workspace_id=m.workspace_id and c.capture_id=m.capture_id "
            "where m.workspace_id=%s and m.job_id=%s and j.scene_id=%s "
            "order by m.ordinal,m.capture_id",
            (scope.workspace_id, job_id, scene_id),
        ).fetchall()
    return [
        ReconstructionSceneMemberRow(
            capture_id=row["capture_id"],
            ordinal=int(row["ordinal"]),
            registered=row["registered"],
            blob_id=BlobId(bytes(row["blob_sha256"])),
        )
        for row in rows
    ]

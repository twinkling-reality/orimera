"""The members of the set a reconstruction was run over.

This module reads ``reconstruction_scene_member`` and its member captures as one table-shaped
question. The result includes deleted captures deliberately: deletion is enforced by the write
guard on the assertion, and filtering a member here would silently turn a claim about N
photographs into one about the survivors.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from orimera.evidence.blob import BlobId
from orimera.ingest.spine.scope import WorkspaceScope

__all__ = ["ReconstructionSceneMemberRow", "members"]


@dataclass(frozen=True, slots=True)
class ReconstructionSceneMemberRow:
    capture_id: uuid.UUID
    ordinal: int
    registered: bool | None
    blob_id: BlobId


def members(
    scope: WorkspaceScope, scene_id: uuid.UUID
) -> list[ReconstructionSceneMemberRow]:
    """Every member in presentation order, including its registration outcome."""
    rows = scope.connection.execute(
        "select m.capture_id, m.ordinal, m.registered, c.blob_sha256 "
        "from reconstruction_scene_member m "
        "join capture c on c.workspace_id = m.workspace_id and c.capture_id = m.capture_id "
        "where m.workspace_id = %s and m.scene_id = %s "
        "order by m.ordinal, m.capture_id",
        (scope.workspace_id, scene_id),
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

"""The rung earned by each live reconstruction scene.

This is not the worst-first reduction used for ``scene_group`` panels. A reconstruction scene is
the set a reconstruction ran over, and its rung is the claim supported by the members that
registered. A scene whose deletion path has been reached is absent even when its assertion row
is still active, because the assertion write guard cannot retract a claim after a later deletion.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import psycopg

from exulanica.epistemics.vocabulary import RECONSTRUCTION_SCENE_RUNG_PREDICATE

__all__ = ["SceneRungRow", "scene_rung_rows"]


@dataclass(frozen=True, slots=True)
class SceneRungRow:
    scene_id: uuid.UUID
    member_capture_ids: list[uuid.UUID]
    registered_capture_ids: list[uuid.UUID]
    rung: int
    reasons: list[Any]
    member_count: int


def scene_rung_rows(connection: psycopg.Connection, workspace: uuid.UUID) -> list[SceneRungRow]:
    """Current scene rung claims whose complete member set remains live."""
    rows = connection.execute(
        "select distinct on (s.scene_id) s.scene_id,a.object_value, "
        "array(select m.capture_id from reconstruction_scene_member m "
        "      where m.workspace_id=s.workspace_id and m.scene_id=s.scene_id "
        "      order by m.ordinal,m.capture_id) as member_capture_ids, "
        "case when s.current_job_id is null then "
        "array(select m.capture_id from reconstruction_scene_member m "
        "      where m.workspace_id=s.workspace_id and m.scene_id=s.scene_id "
        "        and m.registered is true order by m.ordinal,m.capture_id) "
        "else array(select m.capture_id from reconstruction_scene_build_member m "
        "      where m.workspace_id=s.workspace_id and m.job_id=s.current_job_id "
        "        and m.registered is true order by m.ordinal,m.capture_id) "
        "end as registered_capture_ids "
        "from reconstruction_scene s "
        "left join reconstruction_scene_job j on j.workspace_id=s.workspace_id "
        "and j.job_id=s.current_job_id and j.status='succeeded' "
        "join assertion a on a.workspace_id=s.workspace_id "
        " and a.subject_ref->>'type'='scene' and a.subject_ref->>'id'=s.scene_id::text "
        " and (s.current_job_id is null or a.assertion_id=j.rung_assertion_id) "
        "join predicate p on p.predicate_id=a.predicate_id "
        "where s.workspace_id=%s and p.key=%s and a.status='active' "
        "and not tombstone_blocks_scene(s.workspace_id,s.scene_id) "
        "order by s.scene_id,a.asserted_at desc,a.assertion_id desc",
        (workspace, RECONSTRUCTION_SCENE_RUNG_PREDICATE),
    ).fetchall()
    return [
        SceneRungRow(
            scene_id=row["scene_id"],
            member_capture_ids=list(row["member_capture_ids"]),
            registered_capture_ids=list(row["registered_capture_ids"]),
            rung=int(row["object_value"]["rung"]),
            reasons=list(row["object_value"]["reasons"]),
            member_count=int(row["object_value"]["member_count"]),
        )
        for row in rows
    ]

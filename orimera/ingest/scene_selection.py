"""The explicit, replaceable policy that selects scene groups for pose recovery."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Protocol

from orimera.ingest.repository import IngestRepository
from orimera.ingest.scenes import SceneGroup
from orimera.ingest.stages import stage

__all__ = [
    "SceneGroupPosePolicy",
    "SceneJobSelection",
    "SceneReconstructionPolicy",
    "enqueue_scene_reconstructions",
]


@dataclass(frozen=True, slots=True)
class SceneJobSelection:
    job_id: uuid.UUID
    scene_group_ordinal: int
    member_count: int
    inserted: bool


class SceneReconstructionPolicy(Protocol):
    """A versioned policy that either records a selection or declines a scene group."""

    def selection_record(self, group: SceneGroup) -> dict[str, object] | None: ...


@dataclass(frozen=True, slots=True)
class SceneGroupPosePolicy:
    """Select time-ordered scene groups large enough for the current COLMAP defaults.

    The minimum of three is not a claim that three photographs are sufficient for a useful
    model. It is the measured operational floor of the current backend: its reviewed defaults
    discard two-view tracks, so two-image groups cannot produce the geometry this job consumes.
    Quality and registration remain outcomes in the pose receipt.
    """

    minimum_member_count: int = 3

    def __post_init__(self) -> None:
        if self.minimum_member_count < 3:
            raise ValueError("the current pose backend does not accept fewer than three members")

    def selection_record(self, group: SceneGroup) -> dict[str, object] | None:
        if len(group.capture_ids) < self.minimum_member_count:
            return None
        grouping = stage("scene_group")
        return {
            "profile": "orimera.scene-group-pose-selection/v1",
            "minimum_member_count": self.minimum_member_count,
            "ordering": "scene-group-presentation-order",
            "source": {
                "kind": "scene_group",
                "group_key": group.key,
                "group_ordinal": group.ordinal,
                "stage_version": grouping.version,
                "stage_params_sha256": grouping.params_digest.hex(),
            },
            "limitations": [
                "The policy has not been validated against a representative photograph corpus.",
                "Selection does not predict registration or pose quality.",
            ],
        }


def enqueue_scene_reconstructions(
    repository: IngestRepository,
    groups: list[SceneGroup],
    *,
    policy: SceneReconstructionPolicy | None = None,
) -> list[SceneJobSelection]:
    """Apply one recorded policy and durably queue every selected exact capture set."""
    selected_by = policy or SceneGroupPosePolicy()
    selections: list[SceneJobSelection] = []
    for group in groups:
        record = selected_by.selection_record(group)
        if record is None:
            continue
        job_id, inserted = repository.enqueue_reconstruction_scene(
            capture_ids=group.capture_ids,
            selection_policy=record,
        )
        selections.append(
            SceneJobSelection(
                job_id=job_id,
                scene_group_ordinal=group.ordinal,
                member_count=len(group.capture_ids),
                inserted=inserted,
            )
        )
    return selections

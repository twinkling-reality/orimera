"""The wire schema of ``GET /graph``. Seven models that are one document.

Not a route and barely a Python concern: these field names are a contract with
``web/packages/graph-client/src/client.ts``, and the TypeScript side has its own copy. Kept in
one file because the seven ARE one document, and because ``GraphPayload`` gives no field a
default, so a section the assembler forgets is a ValidationError rather than a silent null. That
property only reads clearly when the seven are on one screen.
"""

from __future__ import annotations

import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict

__all__ = [
    "AssertionRow",
    "EntityRow",
    "GraphPayload",
    "HistoryRow",
    "OccurrenceRow",
    "ProposalRow",
    "SceneGroupRow",
]


class AssertionRow(BaseModel):
    """One claim about an entity, with what produced it.

    ``produced_by`` is a discriminated shape rather than a string because the four provenance
    classes carry different obligations: an inference must name its run, a user statement must
    name a human, an external lookup must carry its url and when it was retrieved.
    """

    model_config = ConfigDict(extra="forbid")

    assertion_id: uuid.UUID
    kind: str
    predicate_key: str
    status: str
    object_value: Any
    support_span_ids: list[uuid.UUID]
    produced_by: dict[str, Any]
    asserted_at: str
    supersedes: uuid.UUID | None


class HistoryRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID
    event_type: str
    actor: uuid.UUID
    payload: dict[str, Any]
    undoes: uuid.UUID | None
    created_at: str


class EntityRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_id: uuid.UUID
    entity_class: str
    display_name: str | None
    merged_into: uuid.UUID | None
    occurrence_count: int
    capture_ids: list[uuid.UUID]
    first_seen: str | None
    last_seen: str | None
    open_question_count: int
    assertions: list[AssertionRow]
    history: list[HistoryRow]
    #: Open disputes naming this entity's assertions. Empty until something writes a dispute,
    #: and empty here means "none recorded" rather than "not looked for".
    contradictions: list[dict[str, Any]]


class OccurrenceRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence_id: uuid.UUID
    capture_id: uuid.UUID
    occurrence_class: str
    primary_span_id: uuid.UUID
    entity_id: uuid.UUID | None
    link_state: str | None
    captured_at: str | None


class ProposalRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: uuid.UUID
    occurrence_id: uuid.UUID
    entity_id: uuid.UUID
    rank: int
    outcome: str
    basis: dict[str, Any]
    #: What this proposal carries that the user has not already refused for this pair. NULL when
    #: nothing about the pair was refused before, which is the ordinary case rather than a
    #: missing value. Decision id-4 requires an interface asking again to say what is new.
    new_modality: str | None
    suppressed_by_rejection: bool
    #: The spans the proposed occurrence rests on, so a confirmation surface can show them.
    support_span_ids: list[uuid.UUID]


class SceneGroupRow(BaseModel):
    """One run of captures close in time, and close in space when they carry a position.

    A PROPOSAL about arrangement, not a place and not an entity. ``orimera/ingest/scenes.py``
    is explicit that a scene-local grouping is not a persistent entity, and nothing here promotes
    it to one: the group has no name, and the place proposal that may be attached to it is a
    separate artifact that requires user confirmation.

    ``positioned_member_count`` is carried separately from ``member_count`` because a group whose
    members mostly had no fix was clustered on time alone, and a centroid computed from three of
    sixteen photographs is a different kind of number from one computed from all sixteen.
    """

    model_config = ConfigDict(extra="forbid")

    group_id: uuid.UUID
    ordinal: int
    capture_ids: list[uuid.UUID]
    first_utc: str | None
    last_utc: str | None
    member_count: int
    positioned_member_count: int
    #: Null when no member carried a position. Not zero: zero is a real radius.
    radius_m: int | None
    centroid_lat_e7: int | None
    centroid_lon_e7: int | None
    #: The reconstruction rung the captures in this group earned, WORST FIRST.
    #:
    #: The worst rather than the best or the mean, and that is the honest reduction. A region is
    #: navigable at the level of its weakest part: a group where one photograph has no geometry
    #: has a hole in it, and reporting the average would describe a region nobody can walk
    #: through as though they could. `null` means nothing in the group has been through
    #: reconstruction at all, which is a different fact from rung 4 and is not flattened into it.
    rung: int | None
    #: How many of the group's captures have a recorded rung. A rung derived from two of sixteen
    #: photographs is a weaker claim than one derived from all sixteen, and an interface that
    #: showed them identically would be flattening that.
    rung_capture_count: int


class GraphPayload(BaseModel):
    """One immutable read of the workspace, at one state version."""

    model_config = ConfigDict(extra="forbid")

    state_version: int
    entities: list[EntityRow]
    occurrences: list[OccurrenceRow]
    proposals: list[ProposalRow]
    scene_groups: list[SceneGroupRow]
    never_same: list[tuple[uuid.UUID, uuid.UUID]]
    deleted_entity_ids: list[uuid.UUID]

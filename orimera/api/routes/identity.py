"""The mutation surface. Small, explicit, and structurally unable to say who decided.

``architecture-overview.md`` 1.1 states the front-end rule this mirrors: "``graph-client`` is the
only module permitted to mutate, and it rejects any mutation whose proposal id is not in the
pending proposal set. This is a runtime check, not a lint rule. It exists because the product's
epistemic guarantee is that the system may organize on a guess but never assert on one, and that
guarantee is worthless if any UI component can write an assertion."

The server side of that guarantee is two things:

*   **No request model here has an actor field.** ``decided_by`` and ``stated_by_user`` come from
    the bearer token, so what lands in the column is who the credential belongs to and not what
    the caller typed. A confirmed link records a human decision because the transport cannot
    express any other kind.
*   **A mutation that confirms a system proposal must name it**, and the server checks that the
    proposal is pending and belongs to this workspace before applying anything. A stale proposal
    id, a proposal already answered, or one from another workspace is refused identically.

A mutation the user originates has no proposal to name, and requiring one would be requiring the
system to have guessed first. Naming somebody, or confirming a person the user picked themselves
in the interface, is a statement rather than an agreement, and it carries the actor and nothing
else. That is the line: agreeing with the system needs the system's proposal; speaking for
yourself does not.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from orimera.api.dependencies import WorkspaceIdentity
from orimera.identity import (
    confirm_link,
    merge_entities,
    name_occurrence,
    reject_link,
    revoke_link,
    split_entity,
    undo,
)

router = APIRouter(prefix="/identity", tags=["identity"])

Identity = Annotated[WorkspaceIdentity, Depends(WorkspaceIdentity)]


class NameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence_id: uuid.UUID
    display_name: Annotated[str, Field(min_length=1, max_length=200)]


class LinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence_id: uuid.UUID
    entity_id: uuid.UUID
    #: Required when the caller is agreeing with a match the system proposed. Absent when the
    #: user picked the person themselves, which is a statement rather than an agreement.
    proposal_id: uuid.UUID | None = None


class RevokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence_id: uuid.UUID
    #: Whether to remember the refusal, so the same match is not proposed again identically.
    remember: bool = True


class MergeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sources: Annotated[list[uuid.UUID], Field(min_length=1, max_length=16)]
    target: uuid.UUID


class SplitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_id: uuid.UUID
    occurrence_ids: Annotated[list[uuid.UUID], Field(min_length=1, max_length=64)]


class UndoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID


class NamedView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_id: uuid.UUID
    link_id: uuid.UUID
    assertion_id: uuid.UUID
    event_ids: list[uuid.UUID]


class EventView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID


@router.post("/name", summary="The account holder says who somebody is.")
def name(body: NameRequest, identity: Identity) -> NamedView:
    named = name_occurrence(
        identity.repository,
        identity.assertions,
        occurrence_id=body.occurrence_id,
        display_name=body.display_name,
        actor=identity.session.actor,
    )
    return NamedView(
        entity_id=named.entity_id,
        link_id=named.link_id,
        assertion_id=named.assertion_id,
        event_ids=list(named.event_ids),
    )


@router.post("/confirm", summary="This occurrence is that person.")
def confirm(body: LinkRequest, identity: Identity) -> dict[str, str]:
    _require_pending_proposal(identity, body)
    link_id = confirm_link(
        identity.repository,
        occurrence_id=body.occurrence_id,
        entity_id=body.entity_id,
        actor=identity.session.actor,
    )
    return {"link_id": str(link_id)}


@router.post("/reject", summary="No, that is not them. Remembered against the evidence.")
def reject(body: LinkRequest, identity: Identity) -> dict[str, str]:
    _require_pending_proposal(identity, body)
    rejection_id = reject_link(
        identity.repository,
        occurrence_id=body.occurrence_id,
        entity_id=body.entity_id,
        actor=identity.session.actor,
    )
    return {"rejection_id": str(rejection_id)}


@router.post("/revoke", summary="Withdraw a confirmed link.")
def revoke(body: RevokeRequest, identity: Identity) -> EventView:
    return EventView(
        event_id=revoke_link(
            identity.repository,
            occurrence_id=body.occurrence_id,
            actor=identity.session.actor,
            remember=body.remember,
        )
    )


@router.post("/merge", summary="Two records of one person become one.")
def merge(body: MergeRequest, identity: Identity) -> EventView:
    return EventView(
        event_id=merge_entities(
            identity.repository,
            sources=body.sources,
            target=body.target,
            actor=identity.session.actor,
        )
    )


@router.post("/split", summary="These occurrences are somebody else.")
def split(body: SplitRequest, identity: Identity) -> EventView:
    return EventView(
        event_id=split_entity(
            identity.repository,
            entity_id=body.entity_id,
            occurrence_ids=body.occurrence_ids,
            actor=identity.session.actor,
        )
    )


@router.post("/undo", summary="Reverse one identity decision, from what its event recorded.")
def undo_decision(body: UndoRequest, identity: Identity) -> EventView:
    return EventView(
        event_id=undo(
            identity.repository, event_id=body.event_id, actor=identity.session.actor
        )
    )


@router.get("/events", summary="What has been decided, most recent first.")
def events(identity: Identity, limit: int = 50) -> list[dict]:
    """The identity ledger, which is what makes undo exact rather than approximate."""
    return [
        {
            "event_id": str(row["event_id"]),
            "type": row["type"],
            "payload": row["payload"],
            "undoes": str(row["undoes"]) if row["undoes"] else None,
            "created_at": row["created_at"].isoformat(),
        }
        for row in identity.repository.events(limit=min(limit, 200))
    ]


def _require_pending_proposal(identity: WorkspaceIdentity, body: LinkRequest) -> None:
    """Refuse an answer to a proposal that is not waiting for one.

    Three cases collapse to one refusal, and deliberately: a proposal id that does not exist, one
    that belongs to another workspace, and one that has already been answered. Distinguishing
    them would let a caller learn which proposals exist by submitting ids.

    A request with no proposal id is not checked here, because it is not agreeing with anything.
    """
    if body.proposal_id is None:
        return
    row = identity.connection.execute(
        "select outcome from match_proposal where workspace_id = %s and proposal_id = %s "
        "and occurrence_id = %s and entity_id = %s",
        (
            identity.session.workspace_id,
            body.proposal_id,
            body.occurrence_id,
            body.entity_id,
        ),
    ).fetchone()
    if row is None or row["outcome"] != "surfaced":
        raise HTTPException(
            status_code=409,
            detail=(
                "that proposal is not awaiting an answer. A mutation that agrees with the "
                "system must name the proposal it is agreeing with, and that proposal must "
                "still be pending."
            ),
        )

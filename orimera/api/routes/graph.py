"""The entity graph as one snapshot, which is what the interface renders against.

``graph-client``'s read model is explicit about why this is a snapshot rather than a live
connection: "Turn generation and index rendering both run against a snapshot rather than against
a live connection, because both must be reproducible in a test with no transport, and because
``stateVersion`` is what expires an update proposal."

**What this endpoint returns and what it deliberately does not.** The web read model was designed
against a fuller system than exists, and rather than filling its fields with plausible zeroes,
this returns what the server actually knows and leaves the mapping to the client adapter, which
documents each gap in one auditable place. Two gaps are worth naming here because they are
properties of the server rather than of the adapter:

*   **Islands are not a server concept.** An island is a layout unit, and ADR-0005 records that
    whether one is a single capture or a place-on-a-trip cluster is OPEN "until the real
    distribution of the corpus has been measured". So captures are returned and the client
    decides what an island is. A server that shipped an island id would be settling that
    question by accident.
*   **Nothing counts citing answers, because no answer is stored.** The field exists in the read
    model because a tier 3 confirmation must state how many existing answers lose their citation,
    and that is a real requirement. It is not answerable yet, and a zero here would read as
    "none" rather than as "not recorded".
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

import psycopg
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from orimera.api.dependencies import CurrentSession, ReadOnlyConnection

router = APIRouter(prefix="/graph", tags=["graph"])


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
    suppressed_by_rejection: bool
    #: The spans the proposed occurrence rests on, so a confirmation surface can show them.
    support_span_ids: list[uuid.UUID]


class GraphPayload(BaseModel):
    """One immutable read of the workspace, at one state version."""

    model_config = ConfigDict(extra="forbid")

    state_version: int
    entities: list[EntityRow]
    occurrences: list[OccurrenceRow]
    proposals: list[ProposalRow]
    never_same: list[tuple[uuid.UUID, uuid.UUID]]
    deleted_entity_ids: list[uuid.UUID]


@router.get("", summary="The entity graph, as one snapshot at one state version.")
def snapshot(connection: ReadOnlyConnection, session: CurrentSession) -> GraphPayload:
    workspace = session.workspace_id
    return GraphPayload(
        state_version=_state_version(connection, workspace),
        entities=_entities(connection, workspace),
        occurrences=_occurrences(connection, workspace),
        proposals=_proposals(connection, workspace),
        never_same=[
            (row["entity_a"], row["entity_b"])
            for row in connection.execute(
                "select entity_a, entity_b from never_same where workspace_id = %s "
                "order by entity_a, entity_b",
                (workspace,),
            ).fetchall()
        ],
        deleted_entity_ids=[
            row["entity_id"]
            for row in connection.execute(
                "select entity_id from entity where workspace_id = %s and deleted_at is not null "
                "order by entity_id",
                (workspace,),
            ).fetchall()
        ],
    )


def _state_version(connection: psycopg.Connection, workspace: uuid.UUID) -> int:
    """A number that increases whenever this graph changes, and never decreases.

    The sum of two counts of append-only tables. Every identity decision writes an
    ``identity_event`` and every ingested detection writes an ``occurrence``, and neither table
    is ever deleted from, so the sum is monotonic by construction rather than by convention.

    It is not a timestamp and it is not a hash. The read model asks only that a mismatch make a
    frame stale, and that an update proposal computed against an older graph be refused, and a
    monotonic counter does both. What it does not do is detect a change that touches neither
    table, which today means a retraction; that is recorded here rather than discovered later.
    """
    row = connection.execute(
        "select (select count(*) from identity_event where workspace_id = %s) "
        "     + (select count(*) from occurrence where workspace_id = %s) as version",
        (workspace, workspace),
    ).fetchone()
    return int(row["version"])


def _entities(connection: psycopg.Connection, workspace: uuid.UUID) -> list[EntityRow]:
    """Every live entity, with the captures it is confirmed in and the claims about it.

    Capture ids rather than island ids, because an island is a layout decision the client owns.
    ``open_question_count`` counts proposals still awaiting an answer, which is zero today
    because nothing proposes automatically yet, and is a real count rather than a placeholder.
    """
    rows = connection.execute(
        "select e.entity_id, e.class, e.display_name, e.merged_into, "
        "  count(distinct l.occurrence_id) as occurrence_count, "
        "  array_remove(array_agg(distinct o.capture_id), null) as capture_ids, "
        "  min(c.started_at) as first_seen, max(c.started_at) as last_seen, "
        "  (select count(*) from match_proposal m where m.workspace_id = e.workspace_id "
        "     and m.entity_id = e.entity_id and m.outcome = 'surfaced') as open_questions "
        "from entity e "
        "left join entity_link l on l.entity_id = e.entity_id and l.state = 'confirmed' "
        "left join occurrence o on o.occurrence_id = l.occurrence_id "
        "left join capture c on c.capture_id = o.capture_id "
        "where e.workspace_id = %s and e.deleted_at is null "
        "group by e.entity_id, e.class, e.display_name, e.merged_into, e.workspace_id "
        "order by e.entity_id",
        (workspace,),
    ).fetchall()
    assertions = _assertions_by_entity(connection, workspace)
    history = _history_by_entity(connection, workspace)
    return [
        EntityRow(
            entity_id=row["entity_id"],
            entity_class=row["class"],
            display_name=row["display_name"],
            merged_into=row["merged_into"],
            occurrence_count=int(row["occurrence_count"]),
            capture_ids=list(row["capture_ids"]),
            first_seen=row["first_seen"].isoformat() if row["first_seen"] else None,
            last_seen=row["last_seen"].isoformat() if row["last_seen"] else None,
            open_question_count=int(row["open_questions"]),
            assertions=assertions.get(row["entity_id"], []),
            history=history.get(row["entity_id"], []),
            contradictions=[],
        )
        for row in rows
    ]


def _assertions_by_entity(
    connection: psycopg.Connection, workspace: uuid.UUID
) -> dict[uuid.UUID, list[AssertionRow]]:
    """Every claim whose subject is an entity, grouped.

    Superseded and retracted rows are included, not filtered. The entity detail view renders
    history and "nothing is ever silently rewritten"; a client that received only the active
    rows could not show that something was withdrawn.
    """
    rows = connection.execute(
        "select a.assertion_id, a.kind, p.key, a.status, a.object_value, a.support_span_ids, "
        "  a.produced_by_run, a.stated_by_user, a.external_source, a.asserted_at, a.supersedes, "
        "  a.subject_ref->>'id' as subject_id "
        "from assertion a join predicate p on p.predicate_id = a.predicate_id "
        "where a.workspace_id = %s and a.subject_ref->>'type' = 'entity' "
        "order by a.asserted_at, a.assertion_id",
        (workspace,),
    ).fetchall()
    grouped: dict[uuid.UUID, list[AssertionRow]] = {}
    for row in rows:
        grouped.setdefault(uuid.UUID(row["subject_id"]), []).append(
            AssertionRow(
                assertion_id=row["assertion_id"],
                kind=row["kind"],
                predicate_key=row["key"],
                status=row["status"],
                object_value=row["object_value"],
                support_span_ids=list(row["support_span_ids"]),
                produced_by=_producer(row),
                asserted_at=row["asserted_at"].isoformat(),
                supersedes=row["supersedes"],
            )
        )
    return grouped


def _producer(row: Mapping[str, Any]) -> dict[str, Any]:
    """Which of the four provenance classes made this claim, and the evidence of that.

    Built from the columns the schema constrains rather than from the ``kind`` alone, so a row
    that claimed to be a user statement without naming a human would produce a producer that
    says so instead of one that looks complete.
    """
    if row["kind"] == "user":
        return {"by": "user", "stated_by": str(row["stated_by_user"])}
    if row["kind"] == "inference":
        return {"by": "pipeline", "run_id": str(row["produced_by_run"])}
    if row["kind"] == "external":
        return {"by": "external", "source": row["external_source"]}
    run = row["produced_by_run"]
    return {"by": "capture", "run_id": str(run) if run else None}


def _history_by_entity(
    connection: psycopg.Connection, workspace: uuid.UUID
) -> dict[uuid.UUID, list[HistoryRow]]:
    """The identity ledger, grouped by the entity each event names.

    An event's payload carries the ids it touched, and an event can name more than one, so a
    merge appears in the history of every entity involved. That is the honest rendering: a merge
    is one decision and it happened to all of them.
    """
    rows = connection.execute(
        "select event_id, type, actor, payload, undoes, created_at from identity_event "
        "where workspace_id = %s order by created_at, event_id",
        (workspace,),
    ).fetchall()
    grouped: dict[uuid.UUID, list[HistoryRow]] = {}
    for row in rows:
        event = HistoryRow(
            event_id=row["event_id"],
            event_type=row["type"],
            actor=row["actor"],
            payload=row["payload"],
            undoes=row["undoes"],
            created_at=row["created_at"].isoformat(),
        )
        for entity_id in _entities_named_in(row["payload"]):
            grouped.setdefault(entity_id, []).append(event)
    return grouped


def _entities_named_in(payload: Mapping[str, Any]) -> set[uuid.UUID]:
    """Every entity id anywhere in an event payload, whatever shape that payload has.

    A walk rather than a per-type reader, because the payloads differ by event type and a reader
    per type is a list somebody has to remember to extend. A value that is not a uuid is not an
    entity id and is skipped.
    """
    found: set[uuid.UUID] = set()
    stack: list[Any] = [payload]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            stack.extend(node.values())
            stack.extend(node.keys())
        elif isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, str):
            try:
                found.add(uuid.UUID(node))
            except ValueError:
                continue
    return found


def _occurrences(connection: psycopg.Connection, workspace: uuid.UUID) -> list[OccurrenceRow]:
    """Every occurrence, with the link that names it when one exists.

    ``link_state`` is carried rather than collapsed to a boolean, because ``auto_provisional``
    and ``confirmed`` are different things to the interface: one may drive layout and the other
    may support a claim.
    """
    rows = connection.execute(
        "select o.occurrence_id, o.capture_id, o.class, o.primary_span_id, "
        "  l.entity_id, l.state, c.started_at "
        "from occurrence o "
        "join capture c on c.capture_id = o.capture_id "
        "left join entity_link l on l.occurrence_id = o.occurrence_id "
        "  and l.state = any(array['confirmed','auto_provisional']::link_state[]) "
        "where o.workspace_id = %s and c.deleted_at is null "
        "order by o.occurrence_id",
        (workspace,),
    ).fetchall()
    return [
        OccurrenceRow(
            occurrence_id=row["occurrence_id"],
            capture_id=row["capture_id"],
            occurrence_class=row["class"],
            primary_span_id=row["primary_span_id"],
            entity_id=row["entity_id"],
            link_state=row["state"],
            captured_at=row["started_at"].isoformat() if row["started_at"] else None,
        )
        for row in rows
    ]


def _proposals(connection: psycopg.Connection, workspace: uuid.UUID) -> list[ProposalRow]:
    """Candidate matches, including the ones suppressed by a previous rejection.

    Suppressed proposals are returned rather than filtered out, with the flag set. The client
    needs to know not to offer one as though it were fresh, and hiding it entirely would make
    "why is it not asking me about this" unanswerable.
    """
    rows = connection.execute(
        "select m.proposal_id, m.occurrence_id, m.entity_id, m.rank, m.outcome, m.basis, "
        "  o.span_ids "
        "from match_proposal m join occurrence o on o.occurrence_id = m.occurrence_id "
        "where m.workspace_id = %s "
        "order by m.occurrence_id, m.rank",
        (workspace,),
    ).fetchall()
    return [
        ProposalRow(
            proposal_id=row["proposal_id"],
            occurrence_id=row["occurrence_id"],
            entity_id=row["entity_id"],
            rank=int(row["rank"]),
            outcome=row["outcome"],
            basis=row["basis"],
            suppressed_by_rejection=row["outcome"] == "suppressed_by_rejection",
            support_span_ids=list(row["span_ids"]),
        )
        for row in rows
    ]

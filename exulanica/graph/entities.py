"""The entity half of the snapshot: who is in the library and what is claimed about them.

Split out of the route because eight SQL statements and a ``distinct on`` whose ordering is
load bearing is not what ``orimera/api/__init__.py`` means by "routes validate and delegate;
nothing here decides anything", and because a read model that only has tests through HTTP has no
tests of its own.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

import psycopg

from exulanica.graph.payload import AssertionRow, EntityRow, HistoryRow

__all__ = ["entity_rows"]


def entity_rows(connection: psycopg.Connection, workspace: uuid.UUID) -> list[EntityRow]:
    """Every live entity, with the captures it is confirmed in and the claims about it.

    Capture ids rather than island ids, because an island is a layout decision the client owns.
    ``open_question_count`` counts proposals still AWAITING AN ANSWER, from
    ``pending_match_proposal``. It cannot count ``outcome = 'surfaced'``: outcome records what
    the producer decided, so counting it would count answered proposals forever and the ambient
    counter would read the same number for the rest of time. The view is the same one
    ``/identity/confirm`` checks against, so the count on screen and the check on the write
    cannot disagree.
    """
    rows = connection.execute(
        "select e.entity_id, e.class, e.display_name, e.merged_into, "
        "  count(distinct l.occurrence_id) as occurrence_count, "
        "  array_remove(array_agg(distinct o.capture_id), null) as capture_ids, "
        "  min(c.started_at) as first_seen, max(c.started_at) as last_seen, "
        "  (select count(*) from pending_match_proposal m "
        "     where m.workspace_id = e.workspace_id and m.entity_id = e.entity_id) "
        "     as open_questions "
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

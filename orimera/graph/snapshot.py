"""Assemble one graph snapshot at one state version.

The parts are read on one connection in one request so that they were all true at the same
state version. A grouping fetched at a different moment from the graph it groups can disagree
with it, and the whole value of a snapshot is that its parts agree.

Two reads are inline rather than named. They are one statement each with no shape worth a
function: the pairs a split declared can never be the same person, and the entities that have
been deleted.
"""

from __future__ import annotations

import uuid

import psycopg

from orimera.graph.entities import entity_rows
from orimera.graph.occurrences import occurrence_rows, proposal_rows
from orimera.graph.payload import GraphPayload
from orimera.graph.scene_groups import scene_group_rows

__all__ = ["read_snapshot"]


def read_snapshot(connection: psycopg.Connection, workspace: uuid.UUID) -> GraphPayload:
    """Every section of the graph, read together so they agree with each other."""
    return GraphPayload(
        state_version=_state_version(connection, workspace),
        entities=entity_rows(connection, workspace),
        occurrences=occurrence_rows(connection, workspace),
        proposals=proposal_rows(connection, workspace),
        scene_groups=scene_group_rows(connection, workspace),
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

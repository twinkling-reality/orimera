"""The formation stream: server-sent events for one intake batch.

``interaction-model.md`` 8.4: "Progress arrives as server-sent events per capture, each carrying
stage, stage index, counters, a message, a timestamp and an event id. The client maps events to
visual state and resumes from the last event id on reconnect."

The route validates and delegates. Everything about what an event MEANS lives in
:mod:`orimera.ingest.formation`, which is where the ledger's vocabulary meets the interface's,
and this file decides only how that reaches a browser.

Four things it does decide, each of which is a property of streaming rather than of formation.

**It polls, and says so.** There is no LISTEN/NOTIFY here. Adding one would mean a second
connection held open per subscriber and a notification path that has to agree with the query it
replaces; polling one indexed query on a two-second interval is cheaper than both for a workspace
with one person watching, and its cost is stated below rather than discovered under load.

**It ends when the batch ends.** A stream that stayed open after its terminal event would have an
EventSource reconnecting forever to be told nothing, which is a battery cost with no viewer. The
client is built for that: the reducer holds its last state and nothing advances without an event.

**It sends a comment heartbeat.** A proxy with an idle timeout closes a quiet connection, and a
closed connection looks to the client exactly like a pipeline that stopped. The heartbeat is a
comment line rather than an event so it cannot reach the reducer.

**A subscriber costs a thread.** This is a synchronous endpoint over a synchronous driver, so
Starlette iterates the generator in a threadpool and one open stream occupies one worker for its
lifetime. That is fine for a demonstration with one person watching one upload and it is not fine
for many, and the honest place to record that is here rather than in a load test nobody ran.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterator
from typing import Annotated, Final

import psycopg
from fastapi import APIRouter, Header, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from orimera.api.dependencies import CurrentSession, ReadOnlyConnection
from orimera.ingest.formation import FORMATION_STAGES, FormationEvent, project_formation

router = APIRouter(prefix="/formation", tags=["formation"])

#: How often the ledger is re-read. Slow enough that a watched ingest costs one cheap indexed
#: query every two seconds, fast enough that a stage boundary is visible as it happens rather
#: than as a jump.
_POLL_SECONDS: Final = 2.0

#: A comment line every this many polls, so an idle proxy does not close a live connection.
_HEARTBEAT_EVERY: Final = 7

#: An outcome sorts after every stage, which is what makes "is this the end" a comparison rather
#: than a list of four outcome names kept in step with the projection's own list.
_TERMINAL_INDEX: Final = len(FORMATION_STAGES)

#: The stream gives up after this long. Not a timeout on the pipeline: an ingest that outlives it
#: is still running and the client reconnects with its resume token, which is a path the client
#: already exercises. It exists so a forgotten tab cannot hold a worker thread indefinitely.
_MAX_SECONDS: Final = 30 * 60


def _frame(event: FormationEvent) -> str:
    """One SSE frame. The id line is what the browser sends back as ``Last-Event-ID``."""
    return f"id: {event.event_id}\ndata: {json.dumps(event.as_payload())}\n\n"


class BatchRow(BaseModel):
    """One watched intake, as the interface lists it.

    No photograph, no evidence and nothing citable: a batch is a handle for watching work happen
    and is expected to be useless once the work has happened. ``declared_size`` is null until the
    source has been counted, which is a real state and the reason a client can subscribe before a
    total exists.
    """

    model_config = ConfigDict(extra="forbid")

    batch_id: uuid.UUID
    label: str | None
    declared_size: int | None
    status: str
    started_at: str
    ended_at: str | None


@router.get("", summary="Watched intakes in this workspace, newest first.")
def batches(
    connection: ReadOnlyConnection, session: CurrentSession, limit: int = 20
) -> list[BatchRow]:
    """What there is to watch.

    Finished batches are listed as well as running ones, because a client that arrived after an
    ingest finished should still be able to read what happened rather than find nothing and
    conclude the upload was lost. The stream of a finished batch replays its history and ends,
    which is the same code path a live subscriber takes.
    """
    rows = connection.execute(
        "select batch_id, label, declared_size, status, started_at, ended_at from intake_batch "
        "where workspace_id = %s order by started_at desc limit %s",
        (session.workspace_id, min(max(limit, 1), 100)),
    ).fetchall()
    return [
        BatchRow(
            batch_id=row["batch_id"],
            label=row["label"],
            declared_size=row["declared_size"],
            status=row["status"],
            started_at=row["started_at"].isoformat(),
            ended_at=row["ended_at"].isoformat() if row["ended_at"] else None,
        )
        for row in rows
    ]


@router.get("/{batch_id}", summary="Formation progress for one intake batch, as it happens.")
def stream(
    batch_id: Annotated[uuid.UUID, Path()],
    connection: ReadOnlyConnection,
    session: CurrentSession,
    last_event_id: Annotated[str | None, Header(alias="last-event-id")] = None,
    since: Annotated[str | None, Query(max_length=200)] = None,
) -> StreamingResponse:
    """Subscribe to a batch.

    Two ways to resume, and both exist for a reason. ``Last-Event-ID`` is what a browser's own
    ``EventSource`` sends on an automatic reconnect and the client never has to think about it.
    ``since`` is for a client that reconnects deliberately, having held its own token across a
    view change or a reload, which an ``EventSource`` cannot do because it is a new object with
    no memory.

    The header wins when both are present. A browser sends it only when it genuinely has an event
    to resume from, so it is the more recent of the two by construction.
    """
    resume = last_event_id or since
    # Checked here rather than left to the projection, because 404 on an unknown batch and an
    # empty stream on a known one are different answers and only one of them is true. The check
    # is a workspace-scoped read, so a batch in another workspace is not found, identically to a
    # batch that never existed.
    known = connection.execute(
        "select 1 from intake_batch where workspace_id = %s and batch_id = %s",
        (session.workspace_id, batch_id),
    ).fetchone()
    if known is None:
        raise HTTPException(status_code=404, detail="no such intake batch")

    return StreamingResponse(
        _events(connection, session.workspace_id, batch_id, resume),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            # Nginx buffers a proxied response by default, which turns a stream into one delivery
            # at the end. This is the header it reads to stop.
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _events(
    connection: psycopg.Connection,
    workspace_id: uuid.UUID,
    batch_id: uuid.UUID,
    resume: str | None,
) -> Iterator[str]:
    """Emit what has happened, then what happens next, then stop.

    The generator holds the request's connection for its lifetime, which is the same connection
    the route was given and is released when the response finishes. It reads and never writes.
    """
    token = resume
    started = time.monotonic()
    polls = 0

    while True:
        events = project_formation(connection, workspace_id, batch_id, after=token)
        for event in events:
            yield _frame(event)
            token = event.event_id
        # A terminal event is the end of the stream. The phase is the batch's outcome, and there
        # is nothing after an outcome.
        if events and events[-1].stage_index >= _TERMINAL_INDEX:
            return
        if time.monotonic() - started > _MAX_SECONDS:
            return

        polls += 1
        if polls % _HEARTBEAT_EVERY == 0:
            # A comment. The client's EventSource ignores it and the reducer never sees it, which
            # is exactly what a keep-alive should be: visible to the proxy and to nothing else.
            yield ": keep-alive\n\n"
        # The connection is idle between polls and a snapshot held across them would be stale, so
        # the transaction is closed rather than left open holding a read view of the ledger.
        connection.rollback()
        time.sleep(_POLL_SECONDS)

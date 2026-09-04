"""``orimera-identity propose``. Ask the corpus what it thinks it recognises.

A separate command from ``orimera-ingest`` because the moment that matters is different. Scene
grouping's input is captures, which exist as soon as an ingest finishes, so running it at the end
of an ingest covers every case. This producer's input is NAMED ENTITIES, and the moment one
appears is when a user names an occurrence, after which no ingest follows. Wired only into
ingest, naming somebody would produce no proposals until the next photograph arrived.

So the same function has two callers: the ingest command runs it after grouping, for new
photographs against existing people, and this command runs it on demand, for a new person against
existing photographs.

Running it automatically when ``/identity/name`` succeeds is deliberately NOT done here. It needs
the ``job`` table, which exists in the schema and has no reader and no writer anywhere, and a
whole-corpus scan inside an HTTP handler is the wrong answer to that.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from orimera.db.session import Database
from orimera.identity.proposer import PROPOSER_PARAMS, params_digest, propose_matches
from orimera.identity.repository import IdentityRepository
from orimera.identity.signals import ContextSignals

__all__ = ["main"]


@contextmanager
def _repository(args: argparse.Namespace) -> Iterator[IdentityRepository]:
    """A repository scoped to one workspace, on a session that declared it.

    ``session`` rather than ``unscoped``: every table this reads is under row-level security, and
    a connection that never declared a workspace sees nothing and would report a clean pass over
    an empty corpus. The workspace is an argument rather than read off a data directory, because
    this command is about people rather than about a directory of files.
    """
    database = Database.from_env()
    workspace_id = uuid.UUID(args.workspace)
    with database.session(workspace_id) as connection:
        yield IdentityRepository(connection, workspace_id)


def _start_run(repository: IdentityRepository) -> uuid.UUID:
    """A bare ``pipeline_run``, with no stage events in it, and that is correct rather than thin.

    The Assembly Replay reconstructs how one PHOTOGRAPH was built. A proposal is not a derivative
    of a photograph: it is a function of the whole corpus and of what the user has said. So the
    run exists because ``match_proposal.produced_by_run`` requires one and provenance is worth
    having, and it carries no stage bracket because there is no stage over one file to bracket.
    """
    row = repository.connection.execute(
        "insert into pipeline_run (workspace_id, trigger) values (%s, 'manual') returning run_id",
        (repository.workspace_id,),
    ).fetchone()
    assert row is not None
    return row["run_id"]


def _cmd_propose(args: argparse.Namespace, stream: Any) -> int:
    with _repository(args) as repository:
        signals = ContextSignals.read(repository.connection, repository.workspace_id)
        run_id = _start_run(repository)
        report = propose_matches(repository, signals, run_id=run_id)

    print(f"proposals from context, params {params_digest()}", file=stream)
    print(f"  anchors        {report.anchors} named entities in confirmed captures", file=stream)
    print(f"  candidates     {report.candidates} occurrences linked to nobody", file=stream)
    print(f"  surfaced       {len(report.surfaced)} questions awaiting an answer", file=stream)
    print(
        f"  dropped        {len(report.dropped)} below the surface threshold "
        f"({PROPOSER_PARAMS['surface_threshold_milli']} milli), recorded not shown",
        file=stream,
    )
    print(
        f"  suppressed     {len(report.suppressed)} already refused on this basis",
        file=stream,
    )
    print(
        f"  uncorroborated {report.uncorroborated} pairs matched on label with no context "
        "signal at all, so no question was written",
        file=stream,
    )
    if report.anchors == 0:
        print(
            "\n  nothing to propose from: no entity is confirmed in any capture. Identity is "
            "rung one until somebody names a detection.",
            file=stream,
        )
    return 0


def main(argv: list[str] | None = None, stream: Any = None) -> int:
    stream = stream or sys.stdout
    parser = argparse.ArgumentParser(prog="orimera-identity", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    propose = sub.add_parser(
        "propose", help="propose matches between named people and unlinked detections"
    )
    propose.add_argument("--workspace", required=True, help="the workspace uuid to run over")
    propose.add_argument(
        "--database-url", default=None, help="overrides ORIMERA_DATABASE_URL for this run"
    )
    propose.set_defaults(handler=_cmd_propose)

    args = parser.parse_args(argv)
    return int(args.handler(args, stream))

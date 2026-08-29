"""``python -m orimera.ingest`` : ingest a directory, safely, as many times as you like.

Running it twice is the normal case, not the exception. The second run reports what it skipped
and why, and issues **zero** model calls, because every derivative is keyed by source hash plus
stage version plus parameters. That property is a cost control as much as a correctness one:
without it, re-running after any change means paying for every vision call again.

The catalog preflight runs before the first model call and refuses to continue if a manifest id
has disappeared from the live catalog. A removed model id is otherwise a 404-class failure at
the moment a user is watching.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from orimera.db import Database, apply_pending, provision_workspace
from orimera.ingest.batch import IntakeBatch
from orimera.ingest.ledger import Ledger
from orimera.ingest.pipeline import IngestReport, PhotoIngestPipeline
from orimera.ingest.repository import IngestRepository
from orimera.ingest.scenes import run_scene_grouping
from orimera.ingest.vision import NebiusVisionModel, VisionModel
from orimera.store.local import LocalContentAddressedStore

__all__ = ["main"]

_DEFAULT_DATA_DIR = Path(".orimera/local")


@contextmanager
def _repository(args: argparse.Namespace, stream: Any) -> Iterator[IngestRepository]:
    """A repository over the spine, with the schema up to date and the workspace provisioned.

    Migrating here rather than in a separate command is a decision about this being a
    development CLI: the previous data layer created its schema on open, and losing that would
    make the first run of a checkout fail on a missing table. What it does NOT do is migrate
    silently, because a schema change that nobody noticed is how two deployments end up
    claiming the same version with different tables.
    """
    database = Database.from_env()
    report = apply_pending(database)
    if report.applied:
        print(f"schema: applied migration {', '.join(report.applied)}", file=stream)
    workspace_id = _workspace_id(Path(args.data_dir), args.workspace)
    with database.session(workspace_id) as connection:
        provision_workspace(connection, workspace_id)
        yield IngestRepository(connection, workspace_id)


def _workspace_id(data_dir: Path, explicit: str | None) -> uuid.UUID:
    """One workspace per data directory, remembered on disk.

    A regenerated workspace id would orphan every capture in the database and look, from the
    outside, exactly like an ingest that silently did nothing.
    """
    if explicit:
        return uuid.UUID(explicit)
    marker = data_dir / "workspace.txt"
    if marker.is_file():
        return uuid.UUID(marker.read_text(encoding="utf-8").strip())
    workspace_id = uuid.uuid4()
    data_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(str(workspace_id), encoding="utf-8")
    return workspace_id


def _preflight(stream: Any) -> bool:
    """Check every manifest id against the live catalog. Returns True when all resolve.

    The same check the ``orimera-preflight`` console script runs, called here so an ingest that
    is about to spend money finds out first. A price drift is a warning and is printed; an
    identifier that has been withdrawn, or that no longer declares the ``use_cases`` its role
    needs, is a failure and stops the run.
    """
    from orimera.models.errors import TransportError
    from orimera.models.preflight import run_preflight

    try:
        report = run_preflight()
    except TransportError as exc:
        print(f"preflight: could not reach the catalog ({exc})", file=stream)
        return False
    for issue in report.issues:
        print(f"preflight: {issue}", file=stream)
    if not report.ok:
        print(
            f"preflight: FAILED, {len(report.failures)} of {len(report.checked)} manifest ids "
            "do not resolve against the live catalog",
            file=stream,
        )
        return False
    print(
        f"preflight: all {len(report.checked)} manifest ids resolve against the live catalog",
        file=stream,
    )
    return True


def _build_vision(args: argparse.Namespace, stream: Any) -> VisionModel | None:
    if args.offline:
        print("vision: disabled (--offline). Capture-supported facts only.", file=stream)
        return None
    from orimera.models.cache import FileResponseCache
    from orimera.models.client import ModelClient

    if not args.skip_preflight and not _preflight(stream):
        raise SystemExit(
            "refusing to run the vision stage without a passing catalog preflight. "
            "Pass --skip-preflight only when you know the catalog is unreachable and you "
            "accept a 404-class failure mid-run."
        )
    # The response cache sits beside the rest of the workspace state so the deletion cascade
    # reaches it: its entries are model output over the user's own photographs. Retries are on
    # because a corpus pass is one call per photograph and the platform states plainly that it
    # provides no automatic retry of its own.
    client = ModelClient(
        cache=FileResponseCache(Path(args.data_dir) / "model-cache"),
        max_attempts=3,
    )
    return NebiusVisionModel(client)


def _print_report(report: IngestReport, stream: Any) -> None:
    print(f"\npipeline {report.pipeline_digest}", file=stream)
    print(f"  ingested   {len(report.ingested)}", file=stream)
    print(
        f"  unchanged  {len(report.unchanged)}  "
        f"(already processed at this pipeline version, nothing recomputed, nothing billed)",
        file=stream,
    )
    print(f"  failed     {len(report.failed)}", file=stream)
    print(f"  model calls {report.model_calls}", file=stream)
    tokens_in = sum(o.input_tokens for o in report.outcomes)
    tokens_out = sum(o.output_tokens for o in report.outcomes)
    if tokens_in or tokens_out:
        print(f"  tokens      {tokens_in} in, {tokens_out} out", file=stream)
    if report.incomplete:
        print(
            f"  incomplete {len(report.incomplete)}  (vision never ran for these: no model "
            "configured. They are complete for capture-supported facts and incomplete for "
            "inference.)",
            file=stream,
        )
    for outcome in report.failed:
        print(f"  FAILED {outcome.path}: {outcome.error}", file=stream)


def _cmd_ingest(args: argparse.Namespace, stream: Any) -> int:
    data_dir = Path(args.data_dir)
    store = LocalContentAddressedStore(data_dir / "blobs")
    vision = _build_vision(args, stream)
    with _repository(args, stream) as repository:
        pipeline = PhotoIngestPipeline(repository, store, vision=vision)

        target = Path(args.path)
        print(f"workspace {repository.workspace_id}", file=stream)
        batch: IntakeBatch | None = None
        if target.is_dir():
            batch = IntakeBatch.open(repository, label=str(target))
            report = pipeline.ingest_directory(
                target, recursive=not args.no_recursive, limit=args.limit, batch=batch
            )
        else:
            # One file is not a watched intake. Inventing a batch of one to satisfy the stream
            # would put a single photograph in the place a visitor's upload goes.
            report = IngestReport(pipeline_digest=pipeline.pipeline_digest)
            report.outcomes.append(pipeline.ingest_file(target))

        for outcome in report.outcomes:
            if outcome.error:
                state = "failed"
            else:
                state = "+".join(outcome.stages_run) if outcome.stages_run else "unchanged"
                if outcome.stages_skipped:
                    state += f" (not run: {'+'.join(outcome.stages_skipped)})"
            print(f"  {outcome.path.name:40s} {state}", file=stream)

        # Grouped inside the batch, so continuity search appears in the formation stream as the
        # stage it is. Left outside, it would run in a batchless run and a visitor watching a
        # region form would see the pipeline stop after entity indexing and then finish with no
        # explanation of what happened in between.
        scenes = run_scene_grouping(
            repository,
            ledger=Ledger.start_run(repository, trigger="ingest", batch_id=report.batch_id)
            if report.batch_id
            else None,
        )
        # Closed here, after every stage the batch contains, so its terminal event is genuinely
        # the last one. Closing it when the photographs finished would put "ready" in the stream
        # ahead of continuity search, and a client that stops on the terminal event, which is
        # exactly what a client should do, would never see the stage at all.
        if batch is not None:
            batch.close(
                IntakeBatch.outcome_for(
                    succeeded=len(report.outcomes) - len(report.failed),
                    failed=len(report.failed),
                )
            )
        _print_report(report, stream)
        print(
            f"  scenes      {len(scenes.groups)} groups, {len(scenes.proposals)} place "
            f"proposals awaiting confirmation, {scenes.ungrouped} captures with no timestamp "
            "left ungrouped",
            file=stream,
        )
        if report.batch_id is not None:
            # What a client subscribes to. Printed rather than only stored, because a batch id
            # nobody can read is a stream nobody can watch.
            print(f"  batch       {report.batch_id}", file=stream)
        if args.json:
            json.dump(
                {
                    "workspace_id": str(repository.workspace_id),
                    "batch_id": str(report.batch_id) if report.batch_id else None,
                    "pipeline_digest": report.pipeline_digest,
                    "ingested": len(report.ingested),
                    "unchanged": len(report.unchanged),
                    "failed": len(report.failed),
                    "model_calls": report.model_calls,
                    "scene_groups": len(scenes.groups),
                    "place_proposals": len(scenes.proposals),
                },
                stream,
                indent=2,
            )
            print(file=stream)
    return 1 if report.failed else 0


def _cmd_replay(args: argparse.Namespace, stream: Any) -> int:
    from orimera.ingest.ledger import Ledger

    with _repository(args, stream) as repository:
        ledger = Ledger(repository, uuid.UUID(args.run_id))
        for event in ledger.replay():
            detail = event["stage_key"] or ""
            if event["duration_ms"] is not None:
                detail += f" {event['duration_ms']}ms"
            if event["cost"]:
                detail += f" {event['cost']}"
            if event["error_class"]:
                detail += f" {event['error_class']}: {event['error_message']}"
            print(f"  {event['seq']:>3}  {event['type']:<24} {detail}", file=stream)
    return 0


def main(argv: list[str] | None = None, stream: Any = None) -> int:
    stream = stream or sys.stdout
    parser = argparse.ArgumentParser(prog="orimera-ingest", description=__doc__)
    parser.add_argument("--data-dir", default=str(_DEFAULT_DATA_DIR))
    parser.add_argument("--workspace", default=None, help="workspace uuid; remembered on disk")
    sub = parser.add_subparsers(dest="command", required=True)

    ingest = sub.add_parser("ingest", help="ingest a directory or a single photograph")
    ingest.add_argument("path")
    ingest.add_argument("--limit", type=int, default=None)
    ingest.add_argument("--no-recursive", action="store_true")
    ingest.add_argument(
        "--offline",
        action="store_true",
        help="skip the vision stage; record capture-supported facts only",
    )
    ingest.add_argument("--skip-preflight", action="store_true")
    ingest.add_argument("--json", action="store_true")
    ingest.set_defaults(handler=_cmd_ingest)

    replay = sub.add_parser("replay", help="print the assembly replay for one run")
    replay.add_argument("run_id")
    replay.set_defaults(handler=_cmd_replay)

    args = parser.parse_args(argv)
    return int(args.handler(args, stream))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

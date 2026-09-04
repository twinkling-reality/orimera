"""``exulanica-frontier demonstrate``: the Phase 8 evidence-to-package gate."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import psycopg

from exulanica.canonical import canonical_json
from exulanica.db import Database, DatabaseNotConfigured, apply_pending, provision_workspace
from exulanica.ingest.stages import stage
from exulanica.ingest.vision import NebiusVisionModel, VisionModel
from exulanica.models.cache import FileResponseCache
from exulanica.models.client import ModelClient
from exulanica.models.preflight import run_preflight
from exulanica.orchestration.demonstration import (
    FrontierDemonstrationError,
    run_frontier_demonstration,
)
from exulanica.orchestration.manifest import BuildManifestError, load_build_manifest
from exulanica.reconstruction import DepthModel
from exulanica.world_package.package import PackageError, load_private_key

__all__ = ["main"]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="exulanica-frontier")
    commands = parser.add_subparsers(dest="command", required=True)
    demonstrate = commands.add_parser(
        "demonstrate", help="run the versioned source-to-signed-package frontier gate"
    )
    demonstrate.add_argument("--manifest", type=Path, required=True)
    demonstrate.add_argument("--photo-dir", type=Path, required=True)
    demonstrate.add_argument("--data-dir", type=Path, required=True)
    demonstrate.add_argument("--output", type=Path, required=True)
    demonstrate.add_argument("--private-key", type=Path, required=True)
    demonstrate.add_argument(
        "--confirm-source-deletion",
        action="store_true",
        help=(
            "authorize step 10 to create one durable capture tombstone; the source file itself "
            "is not deleted"
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None, stream: Any = None) -> int:
    stream = stream or sys.stdout
    args = _parser().parse_args(argv)
    try:
        if args.command != "demonstrate":  # pragma: no cover - argparse owns the vocabulary
            raise AssertionError(args.command)
        manifest = load_build_manifest(args.manifest)
        if not args.confirm_source_deletion:
            raise FrontierDemonstrationError(
                "source_deletion_confirmation_required",
                "step 10 creates a durable capture tombstone; pass --confirm-source-deletion",
            )
        private_key = load_private_key(args.private_key)
        vision = _vision_model(manifest.pipeline.vision, args.data_dir)
        depth = _depth_model(manifest.pipeline.depth)
        try:
            database = Database.from_env()
            migration = apply_pending(database)
            with database.session(manifest.workspace_id) as connection:
                provision_workspace(connection, manifest.workspace_id)
                receipt = run_frontier_demonstration(
                    connection,
                    manifest=manifest,
                    photo_dir=args.photo_dir,
                    data_dir=args.data_dir,
                    output=args.output,
                    private_key=private_key,
                    confirm_source_deletion=True,
                    vision=vision,
                    depth=depth,
                )
        except DatabaseNotConfigured as exc:
            raise FrontierDemonstrationError("database_configuration", str(exc)) from exc
        except psycopg.Error as exc:
            raise FrontierDemonstrationError("database_operation", str(exc)) from exc
        _print(
            {
                "status": receipt["status"],
                "receipt": str(args.output / "frontier-receipt.json"),
                "migrations_applied": list(migration.applied),
                "terminal_fallbacks": receipt["terminal_fallbacks"],
            },
            stream,
        )
    except (
        BuildManifestError,
        FrontierDemonstrationError,
        PackageError,
        OSError,
        ValueError,
    ) as exc:
        _write_terminal(args, exc)
        print(str(exc), file=sys.stderr)
        return 1
    return 0


def _vision_model(mode: str, data_dir: Path) -> VisionModel | None:
    if mode == "unavailable":
        return None
    try:
        report = run_preflight()
        report.raise_for_status()
        client = ModelClient(cache=FileResponseCache(data_dir / "model-cache"), max_attempts=3)
        return NebiusVisionModel(client)
    except Exception as exc:
        raise FrontierDemonstrationError(
            "vision_configuration", f"configured vision preflight or credential failed: {exc}"
        ) from exc


def _depth_model(mode: str) -> DepthModel | None:
    if mode == "unavailable":
        return None
    try:
        from exulanica.reconstruction.moge import MoGeDepthModel

        return MoGeDepthModel(max_edge_px=int(stage("depth").params["max_edge_px"]))
    except Exception as exc:
        raise FrontierDemonstrationError(
            "depth_configuration", f"configured MoGe could not load: {exc}"
        ) from exc


def _write_terminal(args: argparse.Namespace, error: Exception) -> None:
    output = getattr(args, "output", None)
    if not isinstance(output, Path) or not output.is_dir():
        return
    path = output / "frontier-terminal.json"
    if path.exists():
        return
    gate = error.gate if isinstance(error, FrontierDemonstrationError) else "input_or_runtime"
    try:
        path.write_bytes(
            canonical_json(
                {
                    "profile": "exulanica-frontier-terminal-v1",
                    "status": "stopped",
                    "gate": gate,
                    "detail": str(error),
                }
            )
        )
    except OSError:
        return


def _print(value: object, stream: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True), file=stream)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

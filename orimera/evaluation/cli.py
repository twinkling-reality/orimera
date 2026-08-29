"""``orimera-eval``. Run what can be measured and say plainly what cannot.

It reads through the database and the HTTP application and WRITES NOTHING. There is no INSERT,
no UPDATE and no DELETE anywhere in this package, ``tests/test_evaluation.py`` scans for one, and
every number here is computed from rows somebody else put there.

That is a rule rather than an accident of what happens to be implemented. Every metric this
harness has had to turn down for want of a write needed a CONFIRMED ENTITY, and an entity exists
only where a person confirmed an occurrence. A harness that confirmed one out of ``MANIFEST.json``
to make its own number computable would be a machine performing a user-class act, which invariant
3 forbids and which no flag or dedicated workspace would change. So such a metric is a blocked row
in ``metrics.py`` carrying the sentence that names what is missing, and it is never bought with a
shortcut into the tables.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import uuid
from typing import Any, Final

from orimera.api.routes import routable_paths
from orimera.db.session import Database
from orimera.evaluation.counts import Count, Sample
from orimera.evaluation.coverage import what_the_corpus_cannot_support
from orimera.evaluation.ground_truth import GroundTruth
from orimera.evaluation.report import render_report
from orimera.evaluation.scorers import (
    score_authorisation,
    score_capture_time_windows,
    score_citation_identity,
    score_provenance_completeness,
)

__all__ = ["SCORED", "main"]

#: The components this harness can produce a result for, and the whole of them.
#:
#: It exists so that "``blocked_on=None`` means the component is runnable", which is what
#: ``metrics.py`` says of that field, is a checkable claim rather than a comment. A row carrying
#: no sentence that nothing here scores renders as the line "NOT MEASURED: None", which is
#: "blocked" and "scored zero" collapsed into one fact. ``_cmd_run`` asserts it filled exactly
#: these, and ``tests/test_evaluation.py`` asserts the metric table agrees with them.
SCORED: Final[tuple[str, ...]] = (
    "M1.cit_id",
    "M5.provenance_completeness",
    "M10.authorisation",
    "M15.capture_time_window_exact_match",
)

_PUBLIC = {"/healthz", "/readyz", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}


def _git_commit() -> str:
    """The commit measured, read from git and never typed.

    A hand-written commit id in a report is one that is wrong the moment anything lands, and a
    report that names the wrong commit is worse than one that names none.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    dirty = subprocess.run(
        ["git", "status", "--porcelain"], capture_output=True, text=True, timeout=10
    ).stdout.strip()
    return result.stdout.strip() + (" (working tree dirty)" if dirty else "")


def _cmd_run(args: argparse.Namespace, stream: Any) -> int:
    truth = GroundTruth.read(args.corpus)
    workspace = uuid.UUID(args.workspace)
    database = Database.from_env()

    from orimera.store.local import LocalContentAddressedStore

    store = LocalContentAddressedStore(pathlib.Path(args.data_dir) / "blobs")

    def read_blob(digest: bytes) -> bytes | None:
        from orimera.evidence.blob import BlobId

        blob = BlobId(digest)
        return store.get(blob) if store.exists(blob) else None

    results: dict[str, Count | Sample | None] = {}
    blocked: dict[str, str] = {}
    with database.session(workspace) as connection:
        results["M1.cit_id"] = score_citation_identity(connection, workspace, truth, read_blob)
        results["M5.provenance_completeness"] = score_provenance_completeness(
            connection, workspace
        )
        windows, why = score_capture_time_windows(connection, workspace, truth)
        results["M15.capture_time_window_exact_match"] = windows
        if windows is None:
            blocked["M15.capture_time_window_exact_match"] = why
        coverage = what_the_corpus_cannot_support(connection, workspace, truth)

    results["M10.authorisation"] = _score_authorisation_over_http(args)
    if results["M10.authorisation"] is None:
        blocked["M10.authorisation"] = (
            "no stranger token was supplied, so no cross-tenant read was attempted. A zero here "
            "would mean the sweep never made a request"
        )

    assert set(results) == set(SCORED), sorted(set(results) ^ set(SCORED))
    report = render_report(
        results,
        corpus_tag=truth.corpus_tag,
        corpus_version=truth.generator,
        manifest_sha256=truth.manifest_sha256,
        synthetic=truth.synthetic,
        disclosure=truth.disclosure,
        frames=len(truth.frames),
        git_commit=_git_commit(),
        blocked=blocked,
        coverage=coverage,
    )
    print(report, file=stream)

    if args.record:
        record = {
            "harness_version": "1",
            "git_commit": _git_commit(),
            "corpus": {
                "id": truth.corpus_tag,
                "corpus_version": truth.generator,
                "manifest_sha256": truth.manifest_sha256,
                "synthetic": truth.synthetic,
                "frames": len(truth.frames),
            },
            # Null with a reason rather than absent. Section 2.0 rule 1 names it as a required
            # key, and a missing key and a blocked one read the same in a JSON file.
            "fixture_version": None,
            "fixture_blocked_on": "no gold question set exists",
            "workspace_id": str(workspace),
            "components": {
                key: None if value is None else {"k": value.k, "n": value.n}
                for key, value in results.items()
                if not isinstance(value, Sample)
            },
        }
        pathlib.Path(args.record).write_text(json.dumps(record, indent=2), encoding="utf-8")
        print(f"\nrecord written to {args.record}", file=stream)
    return 0


def _score_authorisation_over_http(args: argparse.Namespace) -> Count | None:
    """M10, against the real application with a stranger's token.

    Returns None rather than a zero when the application cannot be built. A harness that reported
    "0 unauthorized reads" because it never made a request would be the worst possible version of
    this number.
    """
    try:
        from fastapi.testclient import TestClient

        from orimera.api.app import create_app
    except ImportError:
        return None

    stranger = args.stranger_token
    if not stranger:
        return None
    client = TestClient(create_app())

    def probe(method: str, path: str) -> tuple[int, object]:
        filled = path.replace("{span_id}", str(uuid.uuid4())).replace(
            "{batch_id}", str(uuid.uuid4())
        )
        response = client.request(
            method, filled, headers={"Authorization": f"Bearer {stranger}"}, json={}
        )
        try:
            body: object = response.json()
        except ValueError:
            body = response.text
        return int(response.status_code), body

    return score_authorisation(probe, routable_paths(client.app), _PUBLIC)


def main(argv: list[str] | None = None, stream: Any = None) -> int:
    stream = stream or sys.stdout
    parser = argparse.ArgumentParser(prog="orimera-eval", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="measure what can be measured against a corpus")
    run.add_argument("--corpus", required=True, help="the directory holding MANIFEST.json")
    run.add_argument("--workspace", required=True, help="the workspace uuid the corpus is in")
    run.add_argument("--data-dir", default=".orimera/local", help="where the object store lives")
    run.add_argument("--record", default=None, help="write the machine-readable record here")
    run.add_argument(
        "--stranger-token",
        default=None,
        help="a token for a workspace that owns nothing, so M10 can be scored",
    )
    run.set_defaults(handler=_cmd_run)
    args = parser.parse_args(argv)
    return int(args.handler(args, stream))

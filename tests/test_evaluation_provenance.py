"""Versioned evaluation archives retain exact inputs and refuse silent rewrite."""

from __future__ import annotations

import io
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from orimera.evaluation.cli import main
from orimera.evaluation.provenance import (
    RUN_PROFILE,
    ArchiveError,
    create_archive,
    migration_snapshot,
    model_snapshot,
    pipeline_snapshot,
    repository_snapshot,
    verify_archive,
)


def _record(run_id: str) -> dict[str, object]:
    return {"profile": RUN_PROFILE, "run_id": run_id, "result": "blocked"}


def test_archive_is_exclusive_content_addressed_and_verifiable(tmp_path: Path):
    run_id = str(uuid.uuid4())
    receipt = create_archive(
        tmp_path,
        run_id=run_id,
        record=_record(run_id),
        report="no result: real corpus absent\n",
        snapshots={"snapshots/pipeline.json": b"{}\n"},
    )
    verified = verify_archive(receipt.path, expected_root_sha256=receipt.root_sha256)
    assert verified.root_sha256 == receipt.root_sha256
    assert verified.files == 3
    manifest = json.loads((receipt.path / "MANIFEST.json").read_text())
    assert manifest["storage_guarantee"].endswith("not WORM")

    output = io.StringIO()
    assert (
        main(
            [
                "verify-archive",
                "--archive",
                str(receipt.path),
                "--root-sha256",
                receipt.root_sha256,
            ],
            output,
        )
        == 0
    )
    assert "VERIFIED" in output.getvalue()

    with pytest.raises(ArchiveError, match="will not be overwritten"):
        create_archive(
            tmp_path,
            run_id=run_id,
            record=_record(run_id),
            report="different\n",
            snapshots={},
        )


def test_verifier_detects_changed_bytes_and_uninventoried_files(tmp_path: Path):
    run_id = str(uuid.uuid4())
    receipt = create_archive(
        tmp_path,
        run_id=run_id,
        record=_record(run_id),
        report="blocked\n",
        snapshots={},
    )
    report = receipt.path / "report.txt"
    report.chmod(0o644)
    report.write_text("changed\n")
    with pytest.raises(ArchiveError, match=r"member size changed|member digest changed"):
        verify_archive(receipt.path)

    report.write_text("blocked\n")
    receipt.path.chmod(0o755)
    extra = receipt.path / "untracked.txt"
    extra.write_text("not inventoried")
    with pytest.raises(ArchiveError, match="inventory differs"):
        verify_archive(receipt.path)


def test_repository_snapshot_requires_one_exact_clean_commit(tmp_path: Path):
    repository = tmp_path / "repository"
    repository.mkdir()
    subprocess.run(["git", "init", "-q", str(repository)], check=True)
    tracked = repository / "tracked.txt"
    tracked.write_text("frozen\n")
    subprocess.run(["git", "-C", str(repository), "add", "tracked.txt"], check=True)
    environment = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.invalid",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.invalid",
    }
    subprocess.run(
        ["git", "-C", str(repository), "commit", "-qm", "fixture"],
        check=True,
        env=environment,
    )
    snapshot = repository_snapshot(repository)
    assert snapshot["dirty"] is False
    assert len(str(snapshot["commit"])) == 40
    assert len(str(snapshot["tree"])) == 40

    tracked.write_text("dirty\n")
    with pytest.raises(ArchiveError, match="clean repository"):
        repository_snapshot(repository)


def test_exact_model_stage_and_migration_inputs_are_serializable():
    model, raw = model_snapshot()
    assert len(str(model["sha256"])) == 64
    assert model["roles"]["vision"]["primary"]["model_id"]
    assert model["roles"]["vision"]["primary"]["revision"] is None
    assert raw.startswith(b"{")

    pipeline = pipeline_snapshot({"vision": {"model_id": "fixture/model"}})
    assert pipeline["bindings_complete"] is False
    assert {stage["stage_key"] for stage in pipeline["stages"]} >= {
        "intake",
        "rendition",
        "vision",
        "depth",
    }
    assert len(migration_snapshot()["migrations"]) >= 18

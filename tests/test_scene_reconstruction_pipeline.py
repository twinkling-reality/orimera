"""The production queue consumer from source photographs through the scene rung assertion."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from orimera.evidence.blob import BlobId
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.ingest.scene_reconstruction import SceneReconstructionProcessor
from orimera.ingest.scenes import run_scene_grouping
from orimera.reconstruction.pose import CommandResult
from orimera.store.local import LocalContentAddressedStore

from conftest import CountingVisionModel, write_photo, write_point_map

_CODE_REVISION = "a" * 40
_EXECUTION_IMAGE = "registry.example/orimera-pose@sha256:" + "b" * 64


class FakeColmap:
    def __init__(
        self,
        *,
        registered: int = 2,
        crash_stage: str | None = None,
        fail_stage: str | None = None,
        delete_during=None,
    ) -> None:
        self.calls: list[str] = []
        self.registered = registered
        self.crash_stage = crash_stage
        self.fail_stage = fail_stage
        self.delete_during = delete_during

    def __call__(self, command: tuple[str, ...], cwd: Path) -> CommandResult:
        stage = command[1]
        self.calls.append(stage)
        if stage == self.crash_stage:
            raise SystemExit("simulated process death")
        if stage == self.fail_stage:
            return CommandResult(9, "", "measured pose failure", 1.0)
        (cwd / "database.db").write_bytes(stage.encode())
        if self.delete_during is not None:
            callback, self.delete_during = self.delete_during, None
            callback()
        if stage == "mapper":
            source_directory = Path(command[command.index("--image_path") + 1])
            names = sorted(path.name for path in source_directory.iterdir())[: self.registered]
            model = cwd / "sparse" / "0"
            model.mkdir(parents=True)
            lines: list[str] = []
            for index, name in enumerate(names, 1):
                lines.extend(
                    [
                        f"{index} 1 0 0 0 {-index} 0 0 1 {name}",
                        "0 0 -1",
                    ]
                )
            (model / "images.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
            (model / "points3D.txt").write_text(
                "1 0 0 0 255 255 255 0.4 1 0 2 0\n",
                encoding="utf-8",
            )
        return CommandResult(0, "ok", "", 1.0)


def _queued_scene(repository, tmp_path: Path, *, point_maps: int = 3):
    store = LocalContentAddressedStore(tmp_path / "store")
    pipeline = PhotoIngestPipeline(repository, store, vision=CountingVisionModel())
    photo_directory = tmp_path / "photos"
    photo_directory.mkdir(exist_ok=True)
    captures: list[uuid.UUID] = []
    point_artifacts: list[uuid.UUID] = []
    for index in range(3):
        path = write_photo(
            photo_directory,
            f"{index}.jpg",
            when=f"2026:09:04 12:0{index}:00",
            size=(160 + index, 100),
        )
        outcome = pipeline.ingest_file(path)
        assert outcome.error is None
        assert outcome.capture_id is not None
        captures.append(outcome.capture_id)
        if index < point_maps:
            point_artifact, _content = write_point_map(
                repository,
                store,
                BlobId.of_bytes(path.read_bytes()),
                payload=f"point map {index}".encode(),
            )
            point_artifacts.append(point_artifact)
    report = run_scene_grouping(repository)
    assert len(report.reconstruction_jobs) == 1
    return store, captures, point_artifacts, report.reconstruction_jobs[0]


def _processor(repository, store, tmp_path: Path, executor: FakeColmap):
    return SceneReconstructionProcessor(
        repository,
        store,
        tmp_path / "scratch",
        code_revision=_CODE_REVISION,
        execution_image=_EXECUTION_IMAGE,
        colmap_version="pycolmap test",
        executor=executor,
        retry_delay_seconds=0,
    )


def test_scene_group_pose_placement_gate_and_assertion_commit_together(repository, tmp_path):
    store, captures, point_artifacts, job_id = _queued_scene(repository, tmp_path)
    claimed = repository.claim_reconstruction_scene(worker="test", lease_seconds=60)
    assert claimed is not None and claimed.job_id == job_id

    outcome = _processor(repository, store, tmp_path, FakeColmap(registered=2)).process(claimed)

    assert outcome.status == "succeeded"
    assert outcome.rung == 3
    assert outcome.registered_member_count == 2
    job = repository.connection.execute(
        "select status,pose_manifest_digest,pose_receipt_artifact_id,placement_artifact_id,"
        "gate_artifact_id from reconstruction_scene_job where workspace_id=%s and job_id=%s",
        (repository.workspace_id, job_id),
    ).fetchone()
    assert job is not None and job["status"] == "succeeded"
    assert bytes(job["pose_manifest_digest"])
    artifacts = repository.connection.execute(
        "select artifact_id,kind,content_sha256 from artifact where workspace_id=%s "
        "and scene_id=%s order by kind",
        (repository.workspace_id, outcome.scene_id),
    ).fetchall()
    assert {row["kind"] for row in artifacts} == {
        "pose_receipt",
        "point_map_placement",
        "scene_gate_receipt",
    }
    assert {
        job["pose_receipt_artifact_id"],
        job["placement_artifact_id"],
        job["gate_artifact_id"],
    } == {row["artifact_id"] for row in artifacts}
    members = repository.reconstruction_scene_members(outcome.scene_id)
    assert [(member.capture_id, member.registered) for member in members] == [
        (captures[0], True),
        (captures[1], True),
        (captures[2], False),
    ]
    placement_row = next(row for row in artifacts if row["kind"] == "point_map_placement")
    placement = json.loads(store.get(BlobId(bytes(placement_row["content_sha256"]))))["placement"]
    assert [member["point_map_artifact_ref"] for member in placement["placed"]] == [
        str(point_artifacts[0]),
        str(point_artifacts[1]),
    ]
    assert placement["excluded"] == [
        {
            "capture_ref": str(captures[2]),
            "reason": "pose-not-registered",
            "registered": False,
        }
    ]
    assertion = repository.connection.execute(
        "select object_value from assertion where workspace_id=%s "
        "and subject_ref->>'id'=%s and status='active'",
        (repository.workspace_id, str(outcome.scene_id)),
    ).fetchone()
    assert assertion is not None
    assert assertion["object_value"]["rung"] == 3
    assert assertion["object_value"]["registered_member_count"] == 2
    assert "gate_digest" in assertion["object_value"]
    assert not (tmp_path / "scratch" / claimed.scratch_key).exists()

    second_report = run_scene_grouping(repository)
    assert second_report.reconstruction_jobs == [job_id]
    assert repository.claim_reconstruction_scene(worker="test", lease_seconds=60) is None
    assert repository.connection.execute(
        "select count(*) as count from artifact where workspace_id=%s and scene_id=%s",
        (repository.workspace_id, outcome.scene_id),
    ).fetchone()["count"] == 3


def test_a_process_death_resumes_from_the_last_pose_checkpoint(ingest_spine, tmp_path):
    repository, reopen = ingest_spine
    store, _captures, _point_artifacts, job_id = _queued_scene(repository, tmp_path)
    first = repository.claim_reconstruction_scene(worker="first", lease_seconds=60)
    assert first is not None
    crashing = FakeColmap(registered=3, crash_stage="exhaustive_matcher")

    with pytest.raises(SystemExit, match="simulated process death"):
        _processor(repository, store, tmp_path, crashing).process(first)
    assert crashing.calls == ["feature_extractor", "exhaustive_matcher"]
    assert (tmp_path / "scratch" / first.scratch_key).exists()
    repository.connection.execute(
        "update reconstruction_scene_job set lease_expires_at=now()-interval '1 second' "
        "where workspace_id=%s and job_id=%s",
        (repository.workspace_id, job_id),
    )
    restarted = reopen()
    second = restarted.claim_reconstruction_scene(worker="second", lease_seconds=60)
    assert second is not None and second.reclaimed
    resumed = FakeColmap(registered=3)

    outcome = _processor(restarted, store, tmp_path, resumed).process(second)

    assert outcome.status == "succeeded"
    assert resumed.calls == ["exhaustive_matcher", "mapper"]
    assert not (tmp_path / "scratch" / second.scratch_key).exists()


def test_deletion_during_pose_cancels_without_scene_outputs(repository, tmp_path):
    store, captures, _point_artifacts, job_id = _queued_scene(repository, tmp_path)
    claimed = repository.claim_reconstruction_scene(worker="test", lease_seconds=60)
    assert claimed is not None

    def delete_member() -> None:
        repository.insert_tombstone(
            scope="capture",
            capture_id=captures[1],
            requested_by=uuid.uuid4(),
            reason="deleted while pose recovery was running",
        )

    executor = FakeColmap(registered=3, delete_during=delete_member)
    outcome = _processor(repository, store, tmp_path, executor).process(claimed)

    assert outcome.status == "cancelled"
    row = repository.connection.execute(
        "select status from reconstruction_scene_job where workspace_id=%s and job_id=%s",
        (repository.workspace_id, job_id),
    ).fetchone()
    assert row == {"status": "cancelled"}
    assert repository.connection.execute(
        "select count(*) as count from reconstruction_scene where workspace_id=%s",
        (repository.workspace_id,),
    ).fetchone()["count"] == 0
    assert repository.connection.execute(
        "select count(*) as count from artifact where workspace_id=%s and scene_id is not null",
        (repository.workspace_id,),
    ).fetchone()["count"] == 0
    assert not (tmp_path / "scratch" / claimed.scratch_key).exists()


def test_failed_pose_is_retryable_and_its_sensitive_scratch_is_removed(repository, tmp_path):
    store, _captures, _point_artifacts, job_id = _queued_scene(repository, tmp_path)
    claimed = repository.claim_reconstruction_scene(worker="test", lease_seconds=60)
    assert claimed is not None

    outcome = _processor(
        repository,
        store,
        tmp_path,
        FakeColmap(fail_stage="exhaustive_matcher"),
    ).process(claimed)

    assert outcome.status == "failed"
    row = repository.connection.execute(
        "select status,attempts,completed_at from reconstruction_scene_job "
        "where workspace_id=%s and job_id=%s",
        (repository.workspace_id, job_id),
    ).fetchone()
    assert row == {"status": "failed", "attempts": 1, "completed_at": None}
    assert not (tmp_path / "scratch" / claimed.scratch_key).exists()


def test_registered_member_without_a_point_map_is_explicitly_excluded(repository, tmp_path):
    store, captures, _point_artifacts, _job_id = _queued_scene(
        repository, tmp_path, point_maps=2
    )
    claimed = repository.claim_reconstruction_scene(worker="test", lease_seconds=60)
    assert claimed is not None

    outcome = _processor(repository, store, tmp_path, FakeColmap(registered=3)).process(claimed)

    assert outcome.status == "succeeded"
    row = repository.connection.execute(
        "select content_sha256 from artifact where workspace_id=%s and scene_id=%s "
        "and kind='point_map_placement'",
        (repository.workspace_id, outcome.scene_id),
    ).fetchone()
    placement = json.loads(store.get(BlobId(bytes(row["content_sha256"]))))["placement"]
    assert placement["excluded"] == [
        {
            "capture_ref": str(captures[2]),
            "reason": "point-map-unavailable",
            "registered": True,
        }
    ]

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from exulanica.reconstruction.pose import CommandResult
from exulanica.reconstruction.splat import SplatBuildManifest, run_gsplat_job


def _manifest(**changes) -> SplatBuildManifest:
    source_a = hashlib.sha256(b"source-a").hexdigest()
    source_b = hashlib.sha256(b"source-b").hexdigest()
    values = {
        "scene_ref": "room-1",
        "code_revision": "a" * 40,
        "pose_manifest_digest": "b" * 64,
        "source_sha256": (source_a, source_b),
        "gsplat_revision": "e" * 40,
        "execution_image": "registry.example/gsplat@sha256:" + "f" * 64,
        "dependency_inventory": ("gsplat", "torch"),
        "requested_gpu": "NVIDIA L40S",
        "max_iterations": 30_000,
        "checkpoint_every": 5_000,
        "gaussian_cap": 1_000_000,
        "heldout_every": 8,
        "usd_per_gpu_hour": 0.749,
        "min_psnr": 20.0,
        "min_ssim": 0.7,
        "max_lpips": 0.3,
        "max_floaters_fraction": 0.05,
        "min_coverage_fraction": 0.85,
        "max_browser_bytes": 2_000_000,
    }
    values.update(changes)
    return SplatBuildManifest(**values)


class FakeRunner:
    def __init__(
        self,
        manifest: SplatBuildManifest,
        *,
        psnr: float = 28.0,
        preempt_once: bool = False,
    ):
        self.manifest = manifest
        self.psnr = psnr
        self.preempt_once = preempt_once
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, command: tuple[str, ...], cwd: Path) -> CommandResult:
        self.calls.append(command)
        if command[0] == "exulanica-gsplat-scene-v1":
            output = Path(command[command.index("--output") + 1])
            if self.preempt_once:
                self.preempt_once = False
                checkpoint = output / "checkpoints"
                checkpoint.mkdir(parents=True)
                (checkpoint / "step-5000.pt").write_bytes(b"checkpoint")
                return CommandResult(75, "checkpointed", "", 10.0)
            (output / "accepted.ply").write_bytes(b"ply\n")
            (output / "runtime.json").write_text(
                json.dumps(
                    {
                        "profile": "exulanica.gsplat-scene-runner/v1",
                        "backend": "gsplat",
                        "gsplat_revision": self.manifest.gsplat_revision,
                        "loaded_packages": ["gsplat", "torch"],
                        "iterations_completed": self.manifest.max_iterations,
                        "duration_seconds": 3600.0,
                        "gpu": "NVIDIA L40S serial-redacted",
                        "cuda_version": "12.4",
                        "driver_version": "550.54",
                        "peak_vram_bytes": 8_000_000_000,
                    }
                ),
                encoding="utf-8",
            )
            (output / "metrics.json").write_text(
                json.dumps(
                    {
                        "profile": "exulanica.gsplat-quality/v1",
                        "heldout_views": 4,
                        "psnr": self.psnr,
                        "ssim": 0.86,
                        "lpips": 0.14,
                        "floaters_fraction": 0.02,
                        "coverage_fraction": 0.92,
                    }
                ),
                encoding="utf-8",
            )
            return CommandResult(0, "trained", "", 12.0)
        Path(command[-1]).write_bytes(b"SOG-delivery")
        return CommandResult(0, "compressed", "", 2.0)


def _dataset(path: Path) -> Path:
    path.mkdir()
    images = path / "images"
    images.mkdir()
    (images / "a.jpg").write_bytes(b"source-a")
    (images / "b.jpg").write_bytes(b"source-b")
    (path / "sparse").mkdir()
    return path


def _pose_receipt(path: Path, manifest: SplatBuildManifest) -> Path:
    quality = {
        "accepted": True,
        "metric_scale_metres_per_unit": 0.25,
        "jointly_coregistered": True,
        "shared_metric_frame": True,
    }
    canonical = json.dumps(quality, sort_keys=True, separators=(",", ":")).encode()
    path.write_text(
        json.dumps(
            {
                "manifest_digest": manifest.pose_manifest_digest,
                "quality_digest": hashlib.sha256(canonical).hexdigest(),
                "quality": quality,
            }
        ),
        encoding="utf-8",
    )
    return path


def test_accepted_scene_is_compressed_once_and_reused_from_its_receipt(tmp_path):
    manifest = _manifest()
    fake = FakeRunner(manifest)
    dataset = _dataset(tmp_path / "dataset")
    first = run_gsplat_job(
        manifest,
        dataset_dir=dataset,
        pose_receipt=_pose_receipt(tmp_path / "pose.json", manifest),
        jobs_root=tmp_path / "jobs",
        executor=fake,
    )
    second = run_gsplat_job(
        manifest,
        dataset_dir=dataset,
        pose_receipt=tmp_path / "pose.json",
        jobs_root=tmp_path / "jobs",
        executor=fake,
    )
    assert first.status == "completed" and first.reused is False
    assert second.status == "completed" and second.reused is True
    assert first.quality is not None and first.quality.accepted is True
    assert first.quality.usd_cost == pytest.approx(0.749)
    assert first.quality.delivery_sha256 is not None
    assert len(fake.calls) == 2
    assert fake.calls[1][0] == "splat-transform"


def test_quality_failure_keeps_rung_three_and_never_builds_a_delivery_asset(tmp_path):
    manifest = _manifest()
    fake = FakeRunner(manifest, psnr=12.0)
    result = run_gsplat_job(
        manifest,
        dataset_dir=_dataset(tmp_path / "dataset"),
        pose_receipt=_pose_receipt(tmp_path / "pose.json", manifest),
        jobs_root=tmp_path / "jobs",
        executor=fake,
    )
    assert result.quality is not None and result.quality.accepted is False
    assert result.quality.fallback_rung == 3
    assert any("PSNR" in reason for reason in result.quality.reasons)
    assert len(fake.calls) == 1
    assert not (result.job_directory / "output" / "scene.sog").exists()


def test_preemption_is_distinct_from_failure_and_the_next_call_resumes(tmp_path):
    manifest = _manifest()
    fake = FakeRunner(manifest, preempt_once=True)
    dataset = _dataset(tmp_path / "dataset")
    interrupted = run_gsplat_job(
        manifest,
        dataset_dir=dataset,
        pose_receipt=_pose_receipt(tmp_path / "pose.json", manifest),
        jobs_root=tmp_path / "jobs",
        executor=fake,
    )
    resumed = run_gsplat_job(
        manifest,
        dataset_dir=dataset,
        pose_receipt=tmp_path / "pose.json",
        jobs_root=tmp_path / "jobs",
        executor=fake,
    )
    assert interrupted.status == "checkpointed"
    assert resumed.status == "completed"
    train_commands = [
        command for command in fake.calls if command[0] == "exulanica-gsplat-scene-v1"
    ]
    assert len(train_commands) == 2
    assert all(command[-1] == "auto" for command in train_commands)


@pytest.mark.parametrize(
    "blocked", ["diff-gaussian-rasterization", "diff_gaussian_rasterization", "gaussian-splatting"]
)
def test_the_blocked_inria_rasterizer_is_a_manifest_refusal(blocked):
    with pytest.raises(ValueError, match="blocked INRIA"):
        _manifest(dependency_inventory=("gsplat", blocked))


def test_runtime_package_inventory_is_checked_again_after_execution(tmp_path):
    manifest = _manifest()

    def tainted(command: tuple[str, ...], cwd: Path) -> CommandResult:
        result = FakeRunner(manifest)(command, cwd)
        if command[0] == "exulanica-gsplat-scene-v1":
            output = Path(command[command.index("--output") + 1])
            runtime = json.loads((output / "runtime.json").read_text(encoding="utf-8"))
            runtime["loaded_packages"].append("diff-gaussian-rasterization")
            (output / "runtime.json").write_text(json.dumps(runtime), encoding="utf-8")
        return result

    with pytest.raises(ValueError, match="blocked INRIA"):
        run_gsplat_job(
            manifest,
            dataset_dir=_dataset(tmp_path / "dataset"),
            pose_receipt=_pose_receipt(tmp_path / "pose.json", manifest),
            jobs_root=tmp_path / "jobs",
            executor=tainted,
        )


def test_a_declared_pose_digest_without_an_accepted_metric_receipt_cannot_start_training(tmp_path):
    manifest = _manifest()
    pose = _pose_receipt(tmp_path / "pose.json", manifest)
    receipt = json.loads(pose.read_text(encoding="utf-8"))
    receipt["quality"]["metric_scale_metres_per_unit"] = None
    pose.write_text(json.dumps(receipt), encoding="utf-8")
    with pytest.raises(ValueError, match="digest"):
        run_gsplat_job(
            manifest,
            dataset_dir=_dataset(tmp_path / "dataset"),
            pose_receipt=pose,
            jobs_root=tmp_path / "jobs",
            executor=FakeRunner(manifest),
        )

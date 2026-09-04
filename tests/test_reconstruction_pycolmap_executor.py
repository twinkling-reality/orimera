"""The in-process COLMAP backend, exercised for real where the extra is installed.

Every other pose test drives ``run_colmap_pose_job`` with a fake executor, which proves the
controller's checkpointing and gate and proves nothing about COLMAP. These tests are the other
half: they run the real library through the real controller and assert that a pose job produces a
receipt. They skip where the `pose` extra is absent, which is CI, so the suite that must stay
green stays green and the claim that pose recovery runs is made only where it was executed.

The photographs are renders of the committed courtyard point map, generated here rather than
committed, because the repository has no consented multi-view capture and a fixture of eight
1024x768 images would be 2 MB of test data for a thing that a hundred lines of numpy reproduce.
That makes these tests a check of the wiring and of COLMAP's behaviour on easy input. They are
NOT evidence about photographs, and `docs/reconstruction-findings.md` section 3 says so beside
every number they produce.
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path

import pytest
from exulanica.reconstruction.pose import (
    PoseBuildManifest,
    SourceFrame,
    run_colmap_pose_job,
)

pytest.importorskip("pycolmap", reason="the pose extra is not installed")
numpy = pytest.importorskip("numpy", reason="rendering the synthetic capture needs numpy")
PIL_Image = pytest.importorskip("PIL.Image", reason="rendering the synthetic capture needs Pillow")

from exulanica.reconstruction.pycolmap_executor import (  # noqa: E402  (after the skip guards)
    PYCOLMAP_EXECUTABLE,
    PycolmapExecutor,
    pycolmap_version,
)

_FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "web/packages/app/public/fixtures/memory/glasshouse-courtyard.opm"
)
_VIEWS = 6
_WIDTH, _HEIGHT = 800, 600
_FOV_Y_DEG = 50.0


def _load_point_map(path: Path) -> tuple[object, object]:
    import json
    import struct

    raw = path.read_bytes()
    assert raw[:4] == b"OPM1"
    header = json.loads(raw[8 : 8 + struct.unpack_from("<I", raw, 4)[0]])
    count = header["pointCount"]
    sections = {section["name"]: section for section in header["sections"]}
    position = sections["position"]["byteOffset"]
    colour = sections["color"]["byteOffset"]
    points = numpy.frombuffer(raw, numpy.float32, count * 3, position).reshape(-1, 3)
    colours = numpy.frombuffer(raw, numpy.uint8, count * 4, colour).reshape(-1, 4)[:, :3]
    return points.astype(numpy.float64), colours


def _render(points, colours, centre, target, path: Path) -> None:
    """One view of the point map as square sprites, painted far to near."""
    forward = target - centre
    forward = forward / numpy.linalg.norm(forward)
    right = numpy.cross(forward, numpy.array([0.0, 1.0, 0.0]))
    right = right / numpy.linalg.norm(right)
    up = numpy.cross(right, forward)
    relative = points - centre
    camera = numpy.stack(
        [relative @ right, relative @ up, relative @ forward], axis=1
    )
    front = camera[:, 2] > 0.1
    camera, visible = camera[front], colours[front]
    focal = (_HEIGHT / 2) / math.tan(math.radians(_FOV_Y_DEG) / 2)
    x = camera[:, 0] * focal / camera[:, 2] + _WIDTH / 2
    y = -camera[:, 1] * focal / camera[:, 2] + _HEIGHT / 2
    size = numpy.minimum(0.04 * focal / camera[:, 2], 12.0)
    canvas = numpy.full((_HEIGHT, _WIDTH, 3), 246, numpy.uint8)
    for index in numpy.argsort(-camera[:, 2]):
        radius = size[index] / 2
        x0, x1 = int(x[index] - radius), math.ceil(x[index] + radius)
        y0, y1 = int(y[index] - radius), math.ceil(y[index] + radius)
        if x1 <= 0 or y1 <= 0 or x0 >= _WIDTH or y0 >= _HEIGHT:
            continue
        canvas[max(0, y0) : min(_HEIGHT, y1), max(0, x0) : min(_WIDTH, x1)] = visible[index]
    PIL_Image.fromarray(canvas).save(path, quality=92)


@pytest.fixture(scope="module")
def synthetic_capture(tmp_path_factory) -> Path:
    if not _FIXTURE.is_file():
        pytest.skip(f"{_FIXTURE.name} is a gitignored fixture and is not present")
    points, colours = _load_point_map(_FIXTURE)
    directory = tmp_path_factory.mktemp("capture")
    target = numpy.array([0.0, 0.0, -6.0])
    for index in range(_VIEWS):
        offset = (index / (_VIEWS - 1)) * 2.0 - 1.0
        centre = numpy.array([1.2 * offset, 0.1 * offset, -0.3 - 0.4 * (1 - offset * offset)])
        _render(points, colours, centre, target, directory / f"view_{index:02d}.jpg")
    return directory


def _manifest(source: Path) -> PoseBuildManifest:
    frames = tuple(
        SourceFrame(
            capture_ref=f"capture-{index}",
            filename=path.name,
            sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            capture_set="courtyard",
        )
        for index, path in enumerate(sorted(source.iterdir()))
    )
    return PoseBuildManifest(
        scene_ref="glasshouse-courtyard",
        code_revision="a" * 40,
        # The version the backend reports rather than a string somebody typed, which is the gap
        # `docs/colmap-pose-jobs.md` claims is closed and is not for the subprocess backend.
        colmap_version=pycolmap_version(),
        execution_image="registry.example/exulanica-colmap@sha256:" + "b" * 64,
        frames=frames,
        min_registered_fraction=0.75,
        max_mean_reprojection_error_px=2.0,
        min_camera_translation_units=0.1,
    )


def test_the_in_process_backend_recovers_poses_through_the_unmodified_controller(
    synthetic_capture: Path, tmp_path: Path
):
    """The controller is what ships; this asserts it runs COLMAP rather than a fake.

    Everything checked here is the controller's own output: the receipt it writes, the quality it
    parses out of COLMAP's text export, and the checkpoint that would let a preempted job resume.
    If this passes, the pose path has a backend on this machine.
    """
    result = run_colmap_pose_job(
        _manifest(synthetic_capture),
        source_dir=synthetic_capture,
        jobs_root=tmp_path / "jobs",
        executable=PYCOLMAP_EXECUTABLE,
        executor=PycolmapExecutor(),
    )

    assert result.status == "completed", result.failure_reason
    assert result.quality is not None
    quality = result.quality
    assert quality.source_count == _VIEWS
    assert len(quality.registered_images) == _VIEWS, "every synthetic view should register"
    assert quality.registered_fraction == 1.0
    assert quality.mean_reprojection_error_px is not None
    assert quality.mean_reprojection_error_px < 2.0
    assert quality.camera_translation_extent_units > 0.1
    assert quality.accepted is True
    assert quality.reasons == ()
    # COLMAP is scale ambiguous and the manifest carried no measured scale, so the frame is not
    # metric however well it registered. This is the line rung 2 and rung 1 both wait on.
    assert quality.shared_metric_frame is False

    receipt = result.job_directory / "receipt.json"
    assert receipt.is_file()
    checkpoint = result.job_directory / "checkpoint.json"
    assert checkpoint.is_file()


def test_a_completed_job_is_reused_rather_than_recomputed(
    synthetic_capture: Path, tmp_path: Path
):
    """The expensive half of the controller's contract, against a real backend.

    A second call must return the stored receipt without invoking COLMAP again. The executor here
    fails on any call at all, so a single command would turn the reuse into a failure.
    """
    manifest = _manifest(synthetic_capture)
    jobs_root = tmp_path / "jobs"
    first = run_colmap_pose_job(
        manifest,
        source_dir=synthetic_capture,
        jobs_root=jobs_root,
        executable=PYCOLMAP_EXECUTABLE,
        executor=PycolmapExecutor(),
    )
    assert first.status == "completed"

    def refuse(command: tuple[str, ...], cwd: Path):
        raise AssertionError(f"a reused job must not run {command[1]!r}")

    second = run_colmap_pose_job(
        manifest,
        source_dir=synthetic_capture,
        jobs_root=jobs_root,
        executable=PYCOLMAP_EXECUTABLE,
        executor=refuse,
    )
    assert second.reused is True
    assert second.status == "completed"
    assert second.quality is not None
    assert second.quality.registered_images == first.quality.registered_images


def test_an_unknown_stage_is_a_failed_result_and_not_a_raised_exception():
    """The controller reads a return code and publishes rung 3 with a reason.

    An executor that raised instead would skip the checkpoint write that records which stage
    failed, so the job would lose the one fact worth keeping about its failure.
    """
    outcome = PycolmapExecutor()(("pycolmap", "point_triangulator"), Path.cwd())
    assert outcome.returncode == 1
    assert "point_triangulator" in outcome.stderr

"""Sensitive pose scratch is exact, locked, restartable and eventually removed."""

from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

import pytest
from exulanica.ingest.reconstruction_scratch import (
    ScratchSource,
    active_scene_scratch,
    cleanup_abandoned_scene_scratch,
    cleanup_scene_scratch,
    scene_scratch_key,
    stage_scene_sources,
)
from exulanica.store.local import LocalContentAddressedStore


def _key() -> str:
    return scene_scratch_key(uuid.uuid4(), uuid.uuid4())


def _source(store: LocalContentAddressedStore, name: str, data: bytes) -> ScratchSource:
    stored = store.put_bytes(data)
    return ScratchSource(name, stored.blob_id)


def test_sources_are_exact_and_can_be_reused_after_a_restart(tmp_path: Path):
    root = tmp_path / "scratch"
    store = LocalContentAddressedStore(tmp_path / "store")
    key = _key()
    sources = [_source(store, "000000.jpg", b"first"), _source(store, "000001.png", b"second")]

    with active_scene_scratch(root, key) as job:
        source_directory = stage_scene_sources(store, job, sources)
        assert sorted(path.name for path in source_directory.iterdir()) == [
            "000000.jpg",
            "000001.png",
        ]
    with active_scene_scratch(root, key) as reopened:
        assert stage_scene_sources(store, reopened, sources) == reopened / "source"

    assert (root / key).stat().st_mode & 0o777 == 0o700
    assert (root / key / "source" / "000000.jpg").stat().st_mode & 0o777 == 0o600


def test_extra_or_changed_source_bytes_are_refused(tmp_path: Path):
    root = tmp_path / "scratch"
    store = LocalContentAddressedStore(tmp_path / "store")
    key = _key()
    sources = [_source(store, "000000.jpg", b"original")]

    with active_scene_scratch(root, key) as job:
        source_directory = stage_scene_sources(store, job, sources)
        (source_directory / "000000.jpg").write_bytes(b"changed")
        with pytest.raises(ValueError, match="disagree"):
            stage_scene_sources(store, job, sources)
        (source_directory / "000000.jpg").write_bytes(b"original")
        (source_directory / "undeclared.jpg").write_bytes(b"extra")
        with pytest.raises(ValueError, match="undeclared"):
            stage_scene_sources(store, job, sources)


def test_cleanup_skips_a_live_worker_then_removes_its_terminal_scratch(tmp_path: Path):
    root = tmp_path / "scratch"
    key = _key()

    with active_scene_scratch(root, key) as job:
        (job / "checkpoint").write_bytes(b"durable only until the job ends")
        assert cleanup_scene_scratch(root, key) is False
        assert job.exists()

    assert cleanup_scene_scratch(root, key) is True
    assert not (root / key).exists()
    assert cleanup_scene_scratch(root, key) is False


def test_abandoned_sweep_respects_database_activity_and_age(tmp_path: Path):
    root = tmp_path / "scratch"
    old_key, active_key, young_key = _key(), _key(), _key()
    old_time = time.time() - 7200
    for key in (old_key, active_key, young_key):
        with active_scene_scratch(root, key) as job:
            (job / "work").write_text("sensitive", encoding="utf-8")
        os.utime(root / key, (old_time, old_time))
    os.utime(root / young_key, None)

    removed = cleanup_abandoned_scene_scratch(
        root,
        active_keys=frozenset({active_key}),
        older_than_seconds=3600,
    )

    assert removed == (old_key,)
    assert (root / active_key).exists()
    assert (root / young_key).exists()


def test_cleanup_refuses_paths_that_are_not_exact_scene_keys(tmp_path: Path):
    for key in ("../outside", str(uuid.uuid4()), f"{uuid.uuid4()}/../outside"):
        with pytest.raises(ValueError, match="scratch key"):
            cleanup_scene_scratch(tmp_path / "scratch", key)


def test_a_retry_can_restage_after_failure_cleanup(tmp_path: Path):
    root = tmp_path / "scratch"
    store = LocalContentAddressedStore(tmp_path / "store")
    key = _key()
    sources = [_source(store, "000000.jpg", b"retry input")]

    with active_scene_scratch(root, key) as job:
        stage_scene_sources(store, job, sources)
    assert cleanup_scene_scratch(root, key)
    with active_scene_scratch(root, key) as retried:
        staged = stage_scene_sources(store, retried, sources)
        assert (staged / "000000.jpg").read_bytes() == b"retry input"

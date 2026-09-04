from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path

import pytest
from exulanica.models.manifest import MANIFEST_PATH as MODEL_MANIFEST_PATH
from exulanica.orchestration.cli import main as frontier_main
from exulanica.orchestration.manifest import BuildManifestError, load_build_manifest


def _source(path: Path, root: Path) -> dict[str, object]:
    data = path.read_bytes()
    return {
        "path": path.relative_to(root).as_posix(),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
    }


def _document(photo_dir: Path) -> dict[str, object]:
    sources = [_source(path, photo_dir) for path in sorted(photo_dir.rglob("*.jpg"))]
    return {
        "profile": "exulanica-frontier-build/v1",
        "workspace_id": str(uuid.uuid4()),
        "actor_id": str(uuid.uuid4()),
        "world_id": "atlas:default",
        "sources": sources,
        "pipeline": {
            "vision": "unavailable",
            "depth": "unavailable",
            "model_manifest_sha256": hashlib.sha256(MODEL_MANIFEST_PATH.read_bytes()).hexdigest(),
        },
        "precomputed_artifacts": [],
        "adaptation": {
            "profile_id": "origin-landscape",
            "profile_version": 1,
            "parameters": {"vitality": 1},
            "proposal_provenance": {
                "origin": "companion",
                "origin_reference": "conversation:frontier-style",
                "model_id": "fixture-style-proposer/v1",
                "prompt_version": "fixture-world-recipe/v1",
                "reference_ids": ["design-reference:fixture"],
            },
        },
        "deletion_demo": {"path": sources[0]["path"]},
    }


def _manifest(tmp_path: Path, document: dict[str, object]) -> Path:
    path = tmp_path / "frontier-build.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


@pytest.fixture
def photo_inventory(tmp_path):
    root = tmp_path / "photos"
    root.mkdir()
    (root / "a.jpg").write_bytes(b"first-authorized-photo")
    nested = root / "nested"
    nested.mkdir()
    (nested / "b.jpg").write_bytes(b"second-authorized-photo")
    return root


def test_manifest_binds_the_exact_recursive_photo_inventory(photo_inventory, tmp_path):
    manifest = load_build_manifest(_manifest(tmp_path, _document(photo_inventory)))

    assert manifest.canonical_sha256
    assert [path.name for path in manifest.validate_photo_directory(photo_inventory)] == [
        "a.jpg",
        "b.jpg",
    ]


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda value: value.update({"extra": True}), "keys mismatch"),
        (lambda value: value["pipeline"].update({"vision": "pretend"}), "pipeline.vision"),
        (
            lambda value: value["precomputed_artifacts"].append(
                {
                    "artifact_id": "pose-job",
                    "kind": "colmap",
                    "sha256": "0" * 64,
                    "bytes": 1,
                    "producer": "external",
                    "use": "consume",
                }
            ),
            "disclose-only",
        ),
        (lambda value: value["adaptation"]["parameters"].update({"vitality": 0.5}), "no-float"),
    ],
)
def test_manifest_refuses_unknown_modes_and_float_digest_inputs(
    photo_inventory, tmp_path, mutate, match
):
    document = _document(photo_inventory)
    mutate(document)

    with pytest.raises(BuildManifestError, match=match):
        load_build_manifest(_manifest(tmp_path, document))


def test_manifest_refuses_unlisted_changed_and_symbolic_sources(photo_inventory, tmp_path):
    manifest = load_build_manifest(_manifest(tmp_path, _document(photo_inventory)))
    (photo_inventory / "unlisted.jpg").write_bytes(b"not-authorized")
    with pytest.raises(BuildManifestError, match="unlisted"):
        manifest.validate_photo_directory(photo_inventory)
    (photo_inventory / "unlisted.jpg").unlink()

    (photo_inventory / "a.jpg").write_bytes(b"changed-after-manifest")
    with pytest.raises(BuildManifestError, match="do not match"):
        manifest.validate_photo_directory(photo_inventory)

    (photo_inventory / "a.jpg").unlink()
    os.symlink(photo_inventory / "nested" / "b.jpg", photo_inventory / "a.jpg")
    with pytest.raises(BuildManifestError, match="symbolic link"):
        manifest.validate_photo_directory(photo_inventory)


def test_manifest_refuses_duplicate_source_bytes(photo_inventory, tmp_path):
    same = (photo_inventory / "a.jpg").read_bytes()
    (photo_inventory / "nested" / "b.jpg").write_bytes(same)

    with pytest.raises(BuildManifestError, match="unique byte digests"):
        load_build_manifest(_manifest(tmp_path, _document(photo_inventory)))


def test_manifest_requires_two_sources_for_the_removal_fallback(photo_inventory, tmp_path):
    (photo_inventory / "nested" / "b.jpg").unlink()

    with pytest.raises(BuildManifestError, match="at least two"):
        load_build_manifest(_manifest(tmp_path, _document(photo_inventory)))


def test_manifest_refuses_duplicate_keys_and_parent_traversal(photo_inventory, tmp_path):
    path = _manifest(tmp_path, _document(photo_inventory))
    path.write_text('{"profile":"first","profile":"second"}', encoding="utf-8")
    with pytest.raises(BuildManifestError, match="duplicate JSON key"):
        load_build_manifest(path)

    document = _document(photo_inventory)
    document["sources"][0]["path"] = "../a.jpg"
    with pytest.raises(BuildManifestError, match="relative POSIX path"):
        load_build_manifest(_manifest(tmp_path, document))


def test_command_refuses_the_deletion_step_before_database_or_output_changes(
    photo_inventory, tmp_path, capsys
):
    manifest = _manifest(tmp_path, _document(photo_inventory))
    output = tmp_path / "output"

    result = frontier_main(
        [
            "demonstrate",
            "--manifest",
            str(manifest),
            "--photo-dir",
            str(photo_inventory),
            "--data-dir",
            str(tmp_path / "data"),
            "--output",
            str(output),
            "--private-key",
            str(tmp_path / "not-read.pem"),
        ]
    )

    assert result == 1
    assert "source_deletion_confirmation_required" in capsys.readouterr().err
    assert not output.exists()

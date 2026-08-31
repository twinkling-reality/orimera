from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from orimera.world_package.diff import diff_packages
from orimera.world_package.package import (
    MANIFEST_PATH,
    SIGNATURE_PATH,
    PackageError,
    ProhibitedContentError,
    build_manifest,
    canonical_file,
    import_check_package,
    normalize_value,
    profile_bytes,
    scan_payload,
    sign_manifest,
    verify_package,
)


def _package(
    root: Path, *, captures: list[dict] | None = None, omit: frozenset[str] = frozenset()
) -> Path:
    values = {
        "appearance/style.json": {"state": "unavailable"},
        "deletion/tombstones.json": {"items": []},
        "evaluation/results.json": {"items": [], "state": "unavailable"},
        "evidence/descriptors.json": {"items": []},
        "external/fetch.json": {"items": []},
        "interaction/policy.json": {"state": "unavailable"},
        "memory/graph.json": {"captures": captures or [], "entities": []},
        "policy/export.json": {"export": "default-exclusion"},
        "provenance/events.json": {"items": []},
        "provenance/package.json": {"parent_merkle_root_sha256": None},
        "reconstruction/artifacts.json": {"items": []},
        "world/layout.json": {"state": "unavailable"},
        "world/neighborhood.json": {"state": "unavailable"},
        "world/placement.json": {"state": "unavailable"},
        "world/structure.json": {"state": "unavailable"},
        "world/topology.json": {"state": "unavailable"},
    }
    files = {path: canonical_file(value) for path, value in values.items()}
    files["wmp/profile.json"] = profile_bytes()
    files["ro-crate-metadata.json"] = canonical_file(
        {
            "@context": "https://w3id.org/ro/crate/1.2/context",
            "@graph": [
                {
                    "@id": "ro-crate-metadata.json",
                    "@type": "CreativeWork",
                    "about": {"@id": "./"},
                    "conformsTo": {"@id": "https://w3id.org/ro/crate/1.2"},
                },
                {
                    "@id": "./",
                    "@type": "Dataset",
                    "conformsTo": {
                        "@id": "https://orimera.local/profiles/world-memory-package/1.0"
                    },
                    "description": "A test package.",
                    "name": "Test WMP",
                },
                {
                    "@id": "https://orimera.local/profiles/world-memory-package/1.0",
                    "@type": ["CreativeWork", "Profile"],
                },
                {
                    "@id": "#responsible-ai-boundary",
                    "@type": "Dataset",
                    "http://purl.org/dc/terms/conformsTo": [
                        "http://mlcommons.org/croissant/1.0",
                        "http://mlcommons.org/croissant/RAI/1.0",
                    ],
                },
            ],
        }
    )
    files = {path: data for path, data in files.items() if path not in omit}
    for path, data in files.items():
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    manifest = canonical_file(build_manifest(files))
    key = Ed25519PrivateKey.generate()
    for path, data in (
        (MANIFEST_PATH, manifest),
        (SIGNATURE_PATH, canonical_file(sign_manifest(manifest, key))),
    ):
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    return root


def test_manifest_merkle_and_ed25519_verify_without_database(tmp_path: Path):
    package = _package(tmp_path / "package")
    report = verify_package(package)
    assert report.profile_version == "orimera-wmp-1.0"
    assert report.file_count == 18
    assert len(report.merkle_root_sha256) == 64


def test_one_byte_tampering_is_rejected(tmp_path: Path):
    package = _package(tmp_path / "package")
    path = package / "world/structure.json"
    original = path.read_bytes()
    path.write_bytes(original[:-2] + (b"x" if original[-2:-1] != b"x" else b"y") + original[-1:])
    with pytest.raises(PackageError):
        verify_package(package)


def test_one_byte_manifest_tampering_is_rejected(tmp_path: Path):
    package = _package(tmp_path / "package")
    path = package / MANIFEST_PATH
    original = path.read_bytes()
    index = original.index(b"entries")
    path.write_bytes(original[:index] + b"f" + original[index + 1 :])
    with pytest.raises(PackageError):
        verify_package(package)


def test_correctly_signed_but_incomplete_profile_is_rejected(tmp_path: Path):
    package = _package(
        tmp_path / "package", omit=frozenset({"policy/export.json"})
    )
    with pytest.raises(PackageError, match="incomplete"):
        verify_package(package)


def test_prohibited_content_scanner_rejects_each_default_exclusion_class():
    cases = [
        ("raw-media/source.jpg", {"value": "x"}),
        ("memory/graph.json", {"password": "x"}),
        ("memory/graph.json", {"biometric_template": [1, 2]}),
        ("memory/graph.json", {"embedding": [1, 2]}),
        ("memory/graph.json", {"conversation": "private"}),
        ("memory/graph.json", {"model_internal": "cache"}),
        ("memory/graph.json", {"training_intermediate": "weights"}),
        ("ui/app.js", {"value": "x"}),
        ("memory/graph.json", {"remote_executable": "https://example.invalid/a.js"}),
    ]
    for path, value in cases:
        with pytest.raises(ProhibitedContentError):
            scan_payload(path, value)


def test_binary_float_is_preserved_exactly_as_a_tagged_value():
    assert normalize_value(0.1) == {
        "@type": "orimera:IEEE754Binary64",
        "hex": "0x1.999999999999ap-4",
    }


def test_semantic_diff_names_removed_capture_without_disclosing_values(tmp_path: Path):
    before = _package(
        tmp_path / "before", captures=[{"capture_id": "urn:capture:a", "state": "live"}]
    )
    after = _package(tmp_path / "after")
    result = diff_packages(before, after)
    assert result.changed
    assert "memory/graph.json" in result.changed_files
    assert any(
        change["kind"] == "removed" and "urn:capture:a" in change["pointer"]
        for change in result.semantic_changes
    )
    assert all(
        "before" not in change and "after" not in change for change in result.semantic_changes
    )


def test_clean_process_verification_does_not_need_database_configuration(tmp_path: Path):
    package = _package(tmp_path / "package")
    environment = dict(os.environ)
    environment.pop("ORIMERA_DATABASE_URL", None)
    environment.pop("ORIMERA_TEST_DATABASE_URL", None)
    completed = subprocess.run(
        [sys.executable, "-m", "orimera.world_package.cli", "verify", str(package)],
        capture_output=True,
        check=False,
        env=environment,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["verified"] is True


def test_import_check_is_non_mutating_and_indeterminate_without_receiver_contract(tmp_path: Path):
    package = _package(tmp_path / "package")
    report = import_check_package(package)
    assert report["compatible"] is None
    assert report["mutated"] is False
    assert "indeterminate" in report["warnings"][-1]


def test_unexpected_file_and_symbolic_link_are_rejected(tmp_path: Path):
    package = _package(tmp_path / "package")
    (package / "unexpected.json").write_text("{}", encoding="utf-8")
    with pytest.raises(PackageError, match="inventory mismatch"):
        verify_package(package)

    package = tmp_path / "symbolic"
    shutil.copytree(tmp_path / "package", package)
    (package / "unexpected.json").unlink()
    target = package / "memory/graph.json"
    target.unlink()
    target.symlink_to(package / "world/structure.json")
    with pytest.raises(PackageError):
        verify_package(package)

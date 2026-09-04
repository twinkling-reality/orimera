"""The Phase 2 corpus contract, including the blind access boundary."""

from __future__ import annotations

import hashlib
import json
from io import StringIO
from pathlib import Path

import pytest
from exulanica.evaluation.bundle import (
    BUNDLE_PROFILE,
    SPLIT_PROFILE,
    AccessPurpose,
    CorpusBundle,
    CorpusContractError,
)
from exulanica.evaluation.cli import main


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, indent=2), encoding="utf-8")


def _bundle(
    tmp_path: Path,
    *,
    synthetic: bool = False,
    source_payloads: dict[str, bytes] | None = None,
) -> tuple[Path, str]:
    secret = "blind-fixture-key"
    items = []
    media = []
    consent_records = []
    for split, subject in (("train", "P1"), ("development", "P2"), ("blind", "P3")):
        source = tmp_path / "media" / f"{split}.jpg"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(
            source_payloads[split]
            if source_payloads is not None
            else f"not an image; contract fixture {split}".encode()
        )
        digest = _sha(source)
        consent_id = f"CONSENT-{subject}"
        items.append(
            {
                "item_id": f"PHOTO-{split}",
                "component": "travel",
                "split": split,
                "source_sha256": digest,
                "source_path": f"media/{split}.jpg",
                "subject_ids": [] if synthetic else [subject],
                "consent_record_ids": [] if synthetic else [consent_id],
            }
        )
        media.append({"photo_id": f"PHOTO-{split}", "sha256": digest})
        if not synthetic:
            consent_records.append(
                {
                    "consent_record_id": consent_id,
                    "record_sha256": hashlib.sha256(consent_id.encode()).hexdigest(),
                    "subject_id": subject,
                    "scopes": [
                        "capture.retain_media",
                        "biometric.face_template",
                        "biometric.cross_capture_link",
                    ],
                }
            )

    _write(
        tmp_path / "SPLITS.json",
        {
            "profile": SPLIT_PROFILE,
            "blind_access_key_sha256": hashlib.sha256(secret.encode()).hexdigest(),
            "items": items,
        },
    )
    _write(tmp_path / "CONSENT-INDEX.json", {"records": consent_records})
    layers = {
        layer: f"labels/{layer}.json"
        for layer in ("L0", "L1", "L2", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11")
    }
    for layer, relative in layers.items():
        value = {"media": media} if layer == "L0" else {"layer": layer, "items": []}
        _write(tmp_path / relative, value)
    inventory_paths = ["SPLITS.json", "CONSENT-INDEX.json", *layers.values()]
    _write(
        tmp_path / "CORPUS.json",
        {
            "profile": BUNDLE_PROFILE,
            "corpus_id": "SYNTH-CONTRACT" if synthetic else "OGC-1",
            "synthetic": synthetic,
            "split_manifest": "SPLITS.json",
            "consent_index": "CONSENT-INDEX.json",
            "labels": layers,
            "files": [
                {"path": relative, "sha256": _sha(tmp_path / relative)}
                for relative in inventory_paths
            ],
        },
    )
    return tmp_path, secret


def test_the_bundle_freezes_every_contract_file_and_source(tmp_path: Path):
    root, _secret = _bundle(tmp_path)
    bundle = CorpusBundle.read(root)
    assert bundle.corpus_id == "OGC-1"
    assert len(bundle.corpus_digest) == 64
    assert {item.split for item in bundle.items} == {"train", "development", "blind"}
    assert not hasattr(bundle.items[0], "source_path")

    (root / "labels/L8.json").write_text("{}", encoding="utf-8")
    with pytest.raises(CorpusContractError, match="immutable corpus file changed"):
        CorpusBundle.read(root)


def test_inventory_cannot_smuggle_source_media_into_an_archive(tmp_path: Path):
    root, _secret = _bundle(tmp_path)
    corpus = json.loads((root / "CORPUS.json").read_text())
    corpus["files"].append({"path": "media/train.jpg", "sha256": _sha(root / "media/train.jpg")})
    _write(root / "CORPUS.json", corpus)
    with pytest.raises(CorpusContractError, match="contract and label files only"):
        CorpusBundle.read(root)


def test_a_subject_cannot_leak_across_the_blind_partition(tmp_path: Path):
    root, _secret = _bundle(tmp_path)
    split_path = root / "SPLITS.json"
    split = json.loads(split_path.read_text())
    split["items"][-1]["subject_ids"] = ["P1"]
    _write(split_path, split)
    corpus = json.loads((root / "CORPUS.json").read_text())
    for entry in corpus["files"]:
        if entry["path"] == "SPLITS.json":
            entry["sha256"] = _sha(split_path)
    _write(root / "CORPUS.json", corpus)
    with pytest.raises(CorpusContractError, match="blind subjects also appear"):
        CorpusBundle.read(root)


def test_training_never_receives_a_blind_path_and_blind_needs_the_external_key(tmp_path: Path):
    root, secret = _bundle(tmp_path)
    bundle = CorpusBundle.read(root)
    audit = tmp_path / "audit" / "access.jsonl"
    training, receipt = bundle.open_sources(
        AccessPurpose.TRAINING, audit_path=audit, actor="training-fixture"
    )
    assert [item.split for item in training] == ["train"]
    assert training[0].source_path.name == "train.jpg"
    assert receipt.split == "train"
    assert '"split":"blind"' not in audit.read_text()

    with pytest.raises(CorpusContractError, match="external key"):
        bundle.open_sources(
            AccessPurpose.BLIND_EVALUATION,
            audit_path=audit,
            actor="evaluation-fixture",
        )
    blind, receipt = bundle.open_sources(
        AccessPurpose.BLIND_EVALUATION,
        audit_path=audit,
        actor="evaluation-fixture",
        blind_key=secret,
    )
    assert [item.split for item in blind] == ["blind"]
    assert len(receipt.audit_sha256) == 64

    # Reading it again verifies the existing hash chain before appending.
    bundle.open_sources(
        AccessPurpose.DEVELOPMENT_EVALUATION,
        audit_path=audit,
        actor="evaluation-fixture",
    )

    first_event = json.loads(audit.read_text().splitlines()[0])
    first_event["actor"] = "tampered"
    lines = audit.read_text().splitlines()
    lines[0] = json.dumps(first_event, sort_keys=True, separators=(",", ":"))
    audit.write_text("\n".join(lines) + "\n")
    with pytest.raises(CorpusContractError, match="audit digest fails"):
        bundle.open_sources(
            AccessPurpose.DEVELOPMENT_EVALUATION,
            audit_path=audit,
            actor="evaluation-fixture",
        )


def test_real_subjects_need_a_consent_record_with_every_required_scope(tmp_path: Path):
    root, _secret = _bundle(tmp_path)
    consent_path = root / "CONSENT-INDEX.json"
    consent = json.loads(consent_path.read_text())
    consent["records"][0]["scopes"].remove("biometric.cross_capture_link")
    _write(consent_path, consent)
    corpus = json.loads((root / "CORPUS.json").read_text())
    for entry in corpus["files"]:
        if entry["path"] == "CONSENT-INDEX.json":
            entry["sha256"] = _sha(consent_path)
    _write(root / "CORPUS.json", corpus)
    with pytest.raises(CorpusContractError, match="lacks required evaluation scopes"):
        CorpusBundle.read(root)


def test_synthetic_contract_fixtures_are_explicit_and_need_no_invented_consent(tmp_path: Path):
    root, _secret = _bundle(tmp_path, synthetic=True)
    bundle = CorpusBundle.read(root)
    assert bundle.synthetic is True


def test_source_tampering_is_detected_only_when_access_is_authorised(tmp_path: Path):
    root, _secret = _bundle(tmp_path)
    bundle = CorpusBundle.read(root)
    (root / "media/train.jpg").write_bytes(b"changed")
    # Metadata inspection deliberately does not read private source bytes.
    assert CorpusBundle.read(root).corpus_digest == bundle.corpus_digest
    with pytest.raises(CorpusContractError, match="source bytes changed"):
        bundle.open_sources(
            AccessPurpose.TRAINING,
            audit_path=tmp_path / "access.jsonl",
            actor="training-fixture",
        )


def test_source_path_cannot_resolve_outside_the_bundle(tmp_path: Path):
    root, _secret = _bundle(tmp_path / "bundle")
    external = tmp_path / "external.jpg"
    external.write_bytes((root / "media/train.jpg").read_bytes())
    (root / "media/train.jpg").unlink()
    (root / "media/train.jpg").symlink_to(external)
    with pytest.raises(CorpusContractError, match="resolves outside"):
        CorpusBundle.read(root)


def test_inspection_cli_opens_no_source_media(tmp_path: Path):
    root, _secret = _bundle(tmp_path)
    (root / "media/train.jpg").write_bytes(b"changed after the metadata was frozen")
    output = StringIO()
    assert main(["inspect-corpus", "--corpus", str(root), "--json"], output) == 0
    result = json.loads(output.getvalue())
    assert result["corpus_id"] == "OGC-1"
    assert result["sources_opened"] == 0

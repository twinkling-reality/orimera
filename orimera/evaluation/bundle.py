"""The private OGC-1 input boundary and its split access policy.

This module deliberately does not generate a corpus, consent record, label, or split.  It accepts
an already authorised bundle, verifies that every declared file and source has the frozen digest,
and exposes source paths only through a purpose-scoped reader.  A blind source additionally needs
the external key whose hash was frozen into ``SPLITS.json``.

The access log is a hash-chained JSONL file.  It proves what Orimera's corpus reader opened; it is
not a claim that an operating-system administrator could not read the files by another route.
That boundary is stated explicitly because an audit implemented in application code must not be
described as stronger than it is.
"""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import hmac
import json
import pathlib
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final

from orimera.canonical import canonical_json

__all__ = [
    "BUNDLE_PROFILE",
    "SPLIT_PROFILE",
    "AccessPurpose",
    "AccessReceipt",
    "AuthorizedSource",
    "CorpusBundle",
    "CorpusContractError",
    "CorpusItem",
]

BUNDLE_PROFILE: Final = "orimera.evaluation-corpus/v1"
SPLIT_PROFILE: Final = "orimera.evaluation-splits/v1"
_REQUIRED_LAYERS: Final = frozenset(
    {"L0", "L1", "L2", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11"}
)
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_REAL_REQUIRED_SCOPES: Final = frozenset(
    {"capture.retain_media", "biometric.face_template", "biometric.cross_capture_link"}
)


class CorpusContractError(ValueError):
    """The supplied bundle cannot support an evaluation claim."""


class AccessPurpose(StrEnum):
    """The only purposes that may expose corpus source paths."""

    TRAINING = "training"
    TUNING = "tuning"
    DEVELOPMENT_EVALUATION = "development_evaluation"
    BLIND_EVALUATION = "blind_evaluation"

    @property
    def allowed_splits(self) -> frozenset[str]:
        return {
            self.TRAINING: frozenset({"train"}),
            self.TUNING: frozenset({"development"}),
            self.DEVELOPMENT_EVALUATION: frozenset({"development"}),
            self.BLIND_EVALUATION: frozenset({"blind"}),
        }[self]


@dataclass(frozen=True, slots=True)
class CorpusItem:
    item_id: str
    component: str
    split: str
    source_sha256: str
    subject_ids: tuple[str, ...]
    consent_record_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AuthorizedSource:
    """A source path disclosed by a successful purpose-scoped access."""

    item_id: str
    component: str
    split: str
    source_sha256: str
    source_path: pathlib.Path


@dataclass(frozen=True, slots=True)
class _CorpusEntry:
    item: CorpusItem
    source_path: pathlib.Path


@dataclass(frozen=True, slots=True)
class AccessReceipt:
    purpose: AccessPurpose
    split: str
    actor: str
    item_ids: tuple[str, ...]
    audit_sha256: str


def _read_object(path: pathlib.Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CorpusContractError(f"required corpus file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CorpusContractError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise CorpusContractError(f"{path} must contain one JSON object")
    return value


def _digest_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative(root: pathlib.Path, raw: object, *, field: str) -> pathlib.Path:
    if not isinstance(raw, str) or not raw:
        raise CorpusContractError(f"{field} must be a non-empty relative path")
    relative = pathlib.PurePosixPath(raw)
    if relative.is_absolute() or ".." in relative.parts:
        raise CorpusContractError(f"{field} escapes the corpus directory: {raw!r}")
    candidate = root.joinpath(*relative.parts).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise CorpusContractError(f"{field} resolves outside the corpus directory") from exc
    return candidate


def _sha(value: object, *, field: str) -> str:
    if not isinstance(value, str) or _HEX_64.fullmatch(value) is None:
        raise CorpusContractError(f"{field} must be a lowercase SHA-256 hex digest")
    return value


class CorpusBundle:
    """A verified immutable corpus description.

    Metadata validation reads labels and manifests but never opens source media.  ``open_sources``
    is the sole application path that opens media and therefore the sole path that writes access
    events.  This separation lets CI validate a public contract fixture without pretending it had
    authority to read private photographs.
    """

    def __init__(
        self,
        *,
        root: pathlib.Path,
        document: dict[str, Any],
        entries: tuple[_CorpusEntry, ...],
        corpus_digest: str,
        split_digest: str,
        consent_digest: str,
        blind_key_sha256: str,
    ) -> None:
        self._root = root
        self.document = document
        self.items = tuple(entry.item for entry in entries)
        self._entries = entries
        self.corpus_digest = corpus_digest
        self.split_digest = split_digest
        self.consent_digest = consent_digest
        self.blind_key_sha256 = blind_key_sha256

    @property
    def corpus_id(self) -> str:
        return str(self.document["corpus_id"])

    @property
    def synthetic(self) -> bool:
        return bool(self.document["synthetic"])

    @classmethod
    def read(cls, directory: str | pathlib.Path) -> CorpusBundle:
        root = pathlib.Path(directory).resolve()
        manifest_path = root / "CORPUS.json"
        document = _read_object(manifest_path)
        if document.get("profile") != BUNDLE_PROFILE:
            raise CorpusContractError(
                f"CORPUS.json profile must be {BUNDLE_PROFILE!r}, got {document.get('profile')!r}"
            )
        corpus_id = document.get("corpus_id")
        if not isinstance(corpus_id, str) or not corpus_id:
            raise CorpusContractError("CORPUS.json needs a non-empty corpus_id")
        if not isinstance(document.get("synthetic"), bool):
            raise CorpusContractError("CORPUS.json synthetic must be an explicit boolean")

        labels = document.get("labels")
        if not isinstance(labels, dict) or set(labels) != _REQUIRED_LAYERS:
            missing = sorted(_REQUIRED_LAYERS - set(labels or {}))
            extra = sorted(set(labels or {}) - _REQUIRED_LAYERS)
            raise CorpusContractError(
                f"CORPUS.json labels must name exactly the methodology layers; "
                f"missing={missing}, extra={extra}"
            )
        split_path = _relative(root, document.get("split_manifest"), field="split_manifest")
        consent_path = _relative(root, document.get("consent_index"), field="consent_index")

        inventory = document.get("files")
        if not isinstance(inventory, list) or not inventory:
            raise CorpusContractError("CORPUS.json files must be a non-empty immutable inventory")
        expected: dict[str, str] = {}
        for index, entry in enumerate(inventory):
            if not isinstance(entry, dict):
                raise CorpusContractError(f"files[{index}] must be an object")
            path = _relative(root, entry.get("path"), field=f"files[{index}].path")
            relative = path.relative_to(root).as_posix()
            if relative in expected:
                raise CorpusContractError(f"duplicate inventory path: {relative}")
            expected[relative] = _sha(entry.get("sha256"), field=f"files[{index}].sha256")

        declared = {
            split_path.relative_to(root).as_posix(),
            consent_path.relative_to(root).as_posix(),
            *(
                _relative(root, path, field=f"labels.{layer}").relative_to(root).as_posix()
                for layer, path in labels.items()
            ),
        }
        absent = declared - set(expected)
        if absent:
            raise CorpusContractError(
                f"required files are absent from the inventory: {sorted(absent)}"
            )
        for relative, wanted in expected.items():
            contract_file = root / relative
            if not contract_file.is_file():
                raise CorpusContractError(f"inventoried corpus file is missing: {relative}")
            actual = _digest_file(contract_file)
            if actual != wanted:
                raise CorpusContractError(
                    f"immutable corpus file changed: {relative} is {actual}, expected {wanted}"
                )

        split_document = _read_object(split_path)
        if split_document.get("profile") != SPLIT_PROFILE:
            raise CorpusContractError(f"split manifest profile must be {SPLIT_PROFILE!r}")
        blind_key_sha256 = _sha(
            split_document.get("blind_access_key_sha256"), field="blind_access_key_sha256"
        )
        entries = cls._entries_from(root, split_document)
        items = tuple(entry.item for entry in entries)
        cls._validate_partitions(items)

        consent_document = _read_object(consent_path)
        cls._validate_consent(consent_document, items, synthetic=bool(document["synthetic"]))
        cls._validate_l0(_read_object(_relative(root, labels["L0"], field="labels.L0")), items)

        # The version covers the manifest plus the exact bytes it inventories.  CORPUS.json does
        # not inventory itself because a file cannot contain its own digest.
        version_input = {
            "manifest": document,
            "inventory": sorted(expected.items()),
        }
        return cls(
            root=root,
            document=document,
            entries=entries,
            corpus_digest=hashlib.sha256(canonical_json(version_input)).hexdigest(),
            split_digest=_digest_file(split_path),
            consent_digest=_digest_file(consent_path),
            blind_key_sha256=blind_key_sha256,
        )

    @staticmethod
    def _entries_from(root: pathlib.Path, document: dict[str, Any]) -> tuple[_CorpusEntry, ...]:
        raw_items = document.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            raise CorpusContractError("SPLITS.json items must be non-empty")
        entries: list[_CorpusEntry] = []
        ids: set[str] = set()
        hashes: set[str] = set()
        for index, raw in enumerate(raw_items):
            if not isinstance(raw, dict):
                raise CorpusContractError(f"items[{index}] must be an object")
            item_id = raw.get("item_id")
            if not isinstance(item_id, str) or not item_id or item_id in ids:
                raise CorpusContractError(f"items[{index}].item_id must be unique and non-empty")
            source_sha256 = _sha(raw.get("source_sha256"), field=f"items[{index}].source_sha256")
            if source_sha256 in hashes:
                raise CorpusContractError(
                    f"source digest appears in more than one split: {source_sha256}"
                )
            split = raw.get("split")
            if split not in {"train", "development", "blind"}:
                raise CorpusContractError(f"items[{index}].split is not train/development/blind")
            component = raw.get("component")
            if component not in {"travel", "room"}:
                raise CorpusContractError(f"items[{index}].component is not travel/room")
            subjects = raw.get("subject_ids", [])
            consents = raw.get("consent_record_ids", [])
            if not isinstance(subjects, list) or not all(
                isinstance(value, str) and value for value in subjects
            ):
                raise CorpusContractError(f"items[{index}].subject_ids must be opaque strings")
            if not isinstance(consents, list) or not all(
                isinstance(value, str) and value for value in consents
            ):
                raise CorpusContractError(
                    f"items[{index}].consent_record_ids must be opaque strings"
                )
            if component == "room" and subjects:
                raise CorpusContractError("OGC-1/room must be people-free")
            item = CorpusItem(
                item_id=item_id,
                component=component,
                split=split,
                source_sha256=source_sha256,
                subject_ids=tuple(sorted(set(subjects))),
                consent_record_ids=tuple(sorted(set(consents))),
            )
            entries.append(
                _CorpusEntry(
                    item=item,
                    source_path=_relative(
                        root,
                        raw.get("source_path"),
                        field=f"items[{index}].source_path",
                    ),
                )
            )
            ids.add(item_id)
            hashes.add(source_sha256)
        return tuple(entries)

    @staticmethod
    def _validate_partitions(items: tuple[CorpusItem, ...]) -> None:
        present = {item.split for item in items}
        if present != {"train", "development", "blind"}:
            raise CorpusContractError(f"all three partitions are required, found {sorted(present)}")
        subject_splits: dict[str, set[str]] = {}
        for item in items:
            for subject in item.subject_ids:
                subject_splits.setdefault(subject, set()).add(item.split)
        leaked = {
            subject: splits
            for subject, splits in subject_splits.items()
            if "blind" in splits and len(splits) > 1
        }
        if leaked:
            raise CorpusContractError(
                "blind subjects also appear outside blind: "
                + ", ".join(
                    f"{subject}={sorted(splits)}" for subject, splits in sorted(leaked.items())
                )
            )

    @staticmethod
    def _validate_consent(
        document: dict[str, Any], items: tuple[CorpusItem, ...], *, synthetic: bool
    ) -> None:
        records = document.get("records")
        if not isinstance(records, list):
            raise CorpusContractError("CONSENT-INDEX.json records must be a list")
        by_id: dict[str, dict[str, Any]] = {}
        for index, record in enumerate(records):
            if not isinstance(record, dict):
                raise CorpusContractError(f"consent records[{index}] must be an object")
            record_id = record.get("consent_record_id")
            if not isinstance(record_id, str) or not record_id or record_id in by_id:
                raise CorpusContractError("consent_record_id must be unique and opaque")
            _sha(record.get("record_sha256"), field=f"consent {record_id}.record_sha256")
            subject_id = record.get("subject_id")
            if not isinstance(subject_id, str) or not subject_id:
                raise CorpusContractError(f"consent {record_id}.subject_id must be opaque")
            scopes = record.get("scopes")
            if not isinstance(scopes, list) or not all(isinstance(scope, str) for scope in scopes):
                raise CorpusContractError(f"consent {record_id}.scopes must be strings")
            by_id[record_id] = record
        if synthetic:
            return
        for item in items:
            if item.component == "room":
                continue
            if item.subject_ids and not item.consent_record_ids:
                raise CorpusContractError(
                    f"real travel item {item.item_id} has subjects but no consent record ids"
                )
            if not item.subject_ids and item.consent_record_ids:
                raise CorpusContractError(
                    f"real travel item {item.item_id} has consent ids but no subject ids"
                )
            missing = set(item.consent_record_ids) - set(by_id)
            if missing:
                raise CorpusContractError(
                    f"item {item.item_id} names unknown consents {sorted(missing)}"
                )
            covered_subjects = {
                str(by_id[record_id].get("subject_id")) for record_id in item.consent_record_ids
            }
            if not set(item.subject_ids) <= covered_subjects:
                raise CorpusContractError(
                    f"item {item.item_id} has a subject without a consent record"
                )
            for record_id in item.consent_record_ids:
                scopes = set(by_id[record_id]["scopes"])
                if not scopes >= _REAL_REQUIRED_SCOPES:
                    raise CorpusContractError(
                        f"consent {record_id} lacks required evaluation scopes "
                        f"{sorted(_REAL_REQUIRED_SCOPES - scopes)}"
                    )

    @staticmethod
    def _validate_l0(document: dict[str, Any], items: tuple[CorpusItem, ...]) -> None:
        media = document.get("media")
        if not isinstance(media, list):
            raise CorpusContractError("L0 media manifest needs a media list")
        indexed: set[tuple[str, str]] = set()
        for index, entry in enumerate(media):
            if not isinstance(entry, dict):
                raise CorpusContractError(f"L0.media[{index}] must be an object")
            photo_id = entry.get("photo_id")
            if not isinstance(photo_id, str) or not photo_id:
                raise CorpusContractError(f"L0.media[{index}].photo_id must be non-empty")
            pair = (photo_id, _sha(entry.get("sha256"), field=f"L0.media[{index}].sha256"))
            if pair in indexed:
                raise CorpusContractError(f"L0 contains duplicate media entry {photo_id}")
            indexed.add(pair)
        wanted = {(item.item_id, item.source_sha256) for item in items}
        if indexed != wanted:
            raise CorpusContractError(
                f"L0 source set differs from SPLITS.json: missing={sorted(wanted - indexed)}, "
                f"extra={sorted(indexed - wanted)}"
            )

    def open_sources(
        self,
        purpose: AccessPurpose,
        *,
        audit_path: str | pathlib.Path,
        actor: str,
        blind_key: str | None = None,
    ) -> tuple[tuple[AuthorizedSource, ...], AccessReceipt]:
        """Verify and expose only the split permitted for ``purpose``.

        ``blind_key`` is required only for ``BLIND_EVALUATION``.  Its hash, not the key, is in
        the frozen split manifest.  The audit is written after every source digest is verified,
        and one final receipt event commits the complete item set.
        """
        if not actor.strip():
            raise CorpusContractError("an access actor is required")
        if purpose is AccessPurpose.BLIND_EVALUATION:
            supplied_key_sha256 = (
                hashlib.sha256(blind_key.encode("utf-8")).hexdigest() if blind_key else None
            )
            if supplied_key_sha256 is None or not hmac.compare_digest(
                supplied_key_sha256, self.blind_key_sha256
            ):
                raise CorpusContractError(
                    "blind evaluation requires the external key frozen by SPLITS.json"
                )
        elif blind_key is not None:
            raise CorpusContractError("a blind key may be supplied only to a blind evaluation")

        entries = tuple(
            entry for entry in self._entries if entry.item.split in purpose.allowed_splits
        )
        if not entries:
            raise CorpusContractError(f"no corpus item is authorised for {purpose}")
        for entry in entries:
            if not entry.source_path.is_file():
                raise CorpusContractError(f"authorised source is missing: {entry.item.item_id}")
            actual = _digest_file(entry.source_path)
            if actual != entry.item.source_sha256:
                raise CorpusContractError(
                    f"source bytes changed for {entry.item.item_id}: {actual}, "
                    f"expected {entry.item.source_sha256}"
                )

        audit = pathlib.Path(audit_path)
        audit.parent.mkdir(parents=True, exist_ok=True)
        at = dt.datetime.now(dt.UTC).isoformat()
        with audit.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.seek(0)
            previous = _last_audit_digest(handle.read())
            events: list[dict[str, Any]] = []
            for entry in entries:
                payload = {
                    "schema_version": 1,
                    "event": "source_opened",
                    "occurred_at": at,
                    "actor": actor,
                    "purpose": purpose.value,
                    "split": entry.item.split,
                    "item_id": entry.item.item_id,
                    "source_sha256": entry.item.source_sha256,
                    "corpus_sha256": self.corpus_digest,
                    "previous_event_sha256": previous,
                }
                digest = hashlib.sha256(canonical_json(payload)).hexdigest()
                payload["event_sha256"] = digest
                events.append(payload)
                previous = digest
            receipt_payload = {
                "schema_version": 1,
                "event": "access_completed",
                "occurred_at": at,
                "actor": actor,
                "purpose": purpose.value,
                "split": next(iter(purpose.allowed_splits)),
                "item_ids": [entry.item.item_id for entry in entries],
                "corpus_sha256": self.corpus_digest,
                "previous_event_sha256": previous,
            }
            receipt_digest = hashlib.sha256(canonical_json(receipt_payload)).hexdigest()
            receipt_payload["event_sha256"] = receipt_digest
            events.append(receipt_payload)
            handle.seek(0, 2)
            for event in events:
                handle.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
            handle.flush()
            audit_digest = _digest_file(audit)
        selected = tuple(
            AuthorizedSource(
                item_id=entry.item.item_id,
                component=entry.item.component,
                split=entry.item.split,
                source_sha256=entry.item.source_sha256,
                source_path=entry.source_path,
            )
            for entry in entries
        )
        return selected, AccessReceipt(
            purpose=purpose,
            split=next(iter(purpose.allowed_splits)),
            actor=actor,
            item_ids=tuple(item.item_id for item in selected),
            audit_sha256=audit_digest,
        )


def _last_audit_digest(contents: str) -> str | None:
    previous: str | None = None
    for number, line in enumerate(contents.splitlines(), start=1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CorpusContractError(f"access audit line {number} is invalid JSON") from exc
        if event.get("previous_event_sha256") != previous:
            raise CorpusContractError(f"access audit chain breaks at line {number}")
        digest = event.pop("event_sha256", None)
        actual = hashlib.sha256(canonical_json(event)).hexdigest()
        if digest != actual:
            raise CorpusContractError(f"access audit digest fails at line {number}")
        previous = digest
    return previous

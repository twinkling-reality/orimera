"""The ingest data layer, over the portable subset of migration 0001.

No PostgreSQL server runs in this environment, and the production schema is deeply
PostgreSQL specific: ``int8multirange``, ``halfvec``, ``uuidv7()``, GiST, row-level security and
a tombstone guard trigger. Rather than inventing a fake database or skipping the data layer
altogether, this module writes the **portable subset** the photograph ingest path needs, in
``sqlite_mirror.sql``, with the same table names, the same column names and the same check
constraints. ``tests/test_sqlite_mirror.py`` fails if the mirror invents a column the real
schema does not have, or omits one the real schema requires.

Two rules are enforced here rather than left to callers, because both are invariants and an
invariant enforced by convention is an invariant that is one tired afternoon from being wrong:

*   **``predicate.allows_kind`` is checked on every write.** ``name_is`` allows only ``user``,
    so there is no code path in which a model writes a name. ``caption_is`` and ``ocr_text_is``
    allow only ``inference``, so a vision output cannot be filed as a capture-supported fact.
    The check here raises :class:`EpistemicViolation` with an explanation; the same rule is
    enforced a second time by triggers in ``sqlite_mirror.sql``, and by
    ``tg_assertion_kind_is_allowed()`` in migration 0001, so SQL that bypasses this class is
    refused by the database rather than accepted. This layer exists for the error message, not
    for the guarantee.
*   **Spans, assertions and occurrences are refused when a committed tombstone covers the
    address.** The real guard is a trigger inside the writing transaction, which closes the
    time-of-check-to-time-of-use race in a way an application check cannot. This is the
    portable half of it, and it is the half a stale worker in this process hits.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from orimera.errors import OrimeraError
from orimera.evidence import EvidenceAddress
from orimera.evidence.blob import BlobId

__all__ = [
    "PREDICATE_SEED",
    "ArtifactRow",
    "CaptureRow",
    "EpistemicViolation",
    "IngestRepository",
    "TombstonedError",
    "json_text",
    "utc_now_text",
]

_SCHEMA_PATH: Final = Path(__file__).resolve().parent / "sqlite_mirror.sql"

#: The predicate vocabulary, identical to the seed at the end of migration 0001.
#: ``tests/test_sqlite_mirror.py`` parses that seed and compares it to this tuple, so the two
#: cannot drift apart silently. ``allows_kind`` is doing real work: it is the reason a detector
#: cannot write a name and a caption cannot be filed as capture-supported.
#:
#: Each row is ``(key, value_schema, functional, allows_kind, writes_a_name)``. The last field
#: marks a predicate whose object IS a name; both schemas refuse such a row unless
#: ``allows_kind`` is exactly ``user``, so the rule survives the vocabulary churn that would
#: eventually defeat a hardcoded comparison against the key ``name_is``.
PREDICATE_SEED: Final[
    tuple[tuple[str, dict[str, Any], bool, tuple[str, ...], bool], ...]
] = (
    ("name_is", {"type": "string", "maxLength": 200}, True, ("user",), True),
    ("person_present", {"type": "null"}, False, ("inference", "user"), False),
    ("object_present", {"type": "string"}, False, ("inference", "user"), False),
    ("place_is", {"type": "string"}, True, ("inference", "user"), False),
    ("captured_at", {"type": "string", "format": "date-time"}, True, ("capture", "user"), False),
    ("device_model_is", {"type": "string"}, True, ("capture",), False),
    (
        "gps_position_is",
        {"type": "object", "required": ["lat", "lon"]},
        True,
        ("capture", "user"),
        False,
    ),
    ("pixel_size_is", {"type": "object", "required": ["w", "h"]}, True, ("capture",), False),
    ("caption_is", {"type": "string"}, False, ("inference",), False),
    ("ocr_text_is", {"type": "string"}, False, ("inference",), False),
    ("public_entity_status_is", {"type": "string"}, False, ("external",), False),
)


class EpistemicViolation(OrimeraError):
    """A write would file a claim under a provenance class its predicate does not allow."""


class TombstonedError(OrimeraError):
    """A committed tombstone covers this address. Terminal, never retried."""


@dataclass(frozen=True, slots=True)
class CaptureRow:
    capture_id: uuid.UUID
    blob_id: BlobId
    device_id: str | None
    started_at: str | None
    deleted_at: str | None


@dataclass(frozen=True, slots=True)
class ArtifactRow:
    artifact_id: uuid.UUID
    kind: str
    stage_key: str
    stage_version: int
    idempotency_key: str
    content_sha256: bytes | None
    storage_key: str | None
    byte_size: int | None


def utc_now_text() -> str:
    """The one timestamp format used across the ingest tables: ISO 8601 in UTC."""
    return dt.datetime.now(dt.UTC).isoformat()


def json_text(value: Any) -> str:
    # sort_keys so a stored payload is stable enough to diff between runs by eye. This is not a
    # digest input, so it does not go through orimera.canonical.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class IngestRepository:
    """Everything the ingest path reads and writes, in one place."""

    def __init__(self, connection: sqlite3.Connection, workspace_id: uuid.UUID) -> None:
        self._db = connection
        self._db.row_factory = sqlite3.Row
        self._db.execute("pragma foreign_keys = on")
        self.workspace_id = workspace_id

    @classmethod
    def open(cls, path: str | Path, workspace_id: uuid.UUID) -> IngestRepository:
        connection = sqlite3.connect(str(path), isolation_level=None)
        repository = cls(connection, workspace_id)
        repository.create_schema()
        return repository

    @property
    def connection(self) -> sqlite3.Connection:
        """The live connection. The ledger writes through it, inside the same transaction."""
        return self._db

    def close(self) -> None:
        self._db.close()

    # -- schema -------------------------------------------------------------------------

    def create_schema(self) -> None:
        self._db.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
        self._seed_predicates()

    def _seed_predicates(self) -> None:
        for ordinal, row in enumerate(PREDICATE_SEED, start=1):
            key, schema, functional, allows, writes_a_name = row
            self._db.execute(
                "insert or ignore into predicate (predicate_id, key, value_schema, functional, "
                "allows_kind, writes_a_name, vocab_version) values (?, ?, ?, ?, ?, ?, 1)",
                (
                    ordinal,
                    key,
                    json_text(schema),
                    int(functional),
                    json_text(list(allows)),
                    int(writes_a_name),
                ),
            )

    def register_stages(self, specs: Mapping[str, Any]) -> None:
        """Record the stage registry, so the ledger can be read without the source code."""
        for key, spec in specs.items():
            self._db.execute(
                "insert into stage_registry (stage_key, current_version, model_ref, "
                "params_schema, deterministic, output_kind, updated_at) "
                "values (?, ?, ?, ?, ?, ?, ?) "
                "on conflict(stage_key) do update set current_version = excluded.current_version,"
                " model_ref = excluded.model_ref, params_schema = excluded.params_schema,"
                " deterministic = excluded.deterministic, output_kind = excluded.output_kind,"
                " updated_at = excluded.updated_at",
                (
                    key,
                    spec.version,
                    json_text({"role": spec.model_role}) if spec.model_role else None,
                    json_text(spec.params),
                    int(spec.deterministic),
                    spec.output_kind,
                    utc_now_text(),
                ),
            )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """One stage's writes land together or not at all.

        This is the portable half of the producer protocol: the artifact row, its assertions
        and its ledger event share a transaction, and every emitted row carries a deterministic
        emit key under a unique constraint. A worker that dies halfway and is retried produces
        the same keys, the conflicts absorb the duplicates, and the effect is exactly once on
        top of at-least-once execution.
        """
        self._db.execute("begin immediate")
        try:
            yield self._db
        except BaseException:
            self._db.execute("rollback")
            raise
        self._db.execute("commit")

    # -- media layer --------------------------------------------------------------------

    def upsert_blob(
        self, blob_id: BlobId, *, byte_size: int, media_type: str, storage_key: str
    ) -> bool:
        """Register bytes. Returns True when this workspace had not seen them before."""
        cursor = self._db.execute(
            "insert or ignore into blob (blob_sha256, byte_size, media_type, storage_key, "
            "first_seen_at) values (?, ?, ?, ?, ?)",
            (blob_id.digest, byte_size, media_type, storage_key, utc_now_text()),
        )
        return cursor.rowcount > 0

    def live_capture_for_blob(self, blob_id: BlobId) -> CaptureRow | None:
        row = self._db.execute(
            "select capture_id, blob_sha256, device_id, started_at, deleted_at from capture "
            "where workspace_id = ? and blob_sha256 = ? and deleted_at is null",
            (str(self.workspace_id), blob_id.digest),
        ).fetchone()
        return self._capture_row(row) if row else None

    @staticmethod
    def _capture_row(row: sqlite3.Row) -> CaptureRow:
        return CaptureRow(
            capture_id=uuid.UUID(row["capture_id"]),
            blob_id=BlobId(row["blob_sha256"]),
            device_id=row["device_id"],
            started_at=row["started_at"],
            deleted_at=row["deleted_at"],
        )

    def insert_capture(
        self, blob_id: BlobId, *, device_id: str | None, started_at: str | None
    ) -> CaptureRow:
        capture_id = uuid.uuid4()
        self._db.execute(
            "insert into capture (capture_id, workspace_id, blob_sha256, device_id, started_at, "
            "created_at) values (?, ?, ?, ?, ?, ?)",
            (
                str(capture_id),
                str(self.workspace_id),
                blob_id.digest,
                device_id,
                started_at,
                utc_now_text(),
            ),
        )
        return CaptureRow(
            capture_id=capture_id,
            blob_id=blob_id,
            device_id=device_id,
            started_at=started_at,
            deleted_at=None,
        )

    def upsert_image_track(
        self,
        blob_id: BlobId,
        *,
        coded_w: int,
        coded_h: int,
        disp_w: int,
        disp_h: int,
        rotation: int,
        codec: str,
        probe_json: dict[str, Any],
    ) -> uuid.UUID:
        """Register the single-sample ``img`` track a photograph is modelled as.

        ``time_base 1/1_000_000_000``, ``start_pts 0``, ``duration_ns 1``. The interval exists
        even though a photograph has no duration, so the overlap, tombstone and co-presence
        paths are exercised by this corpus rather than left untested until video arrives.
        """
        existing = self._db.execute(
            "select track_id from media_track where blob_sha256 = ? and track_key = 'img'",
            (blob_id.digest,),
        ).fetchone()
        if existing:
            return uuid.UUID(existing["track_id"])
        track_id = uuid.uuid4()
        self._db.execute(
            "insert into media_track (track_id, blob_sha256, track_key, kind, time_base_num, "
            "time_base_den, start_pts, duration_ns, coded_w, coded_h, disp_w, disp_h, rotation, "
            "sar_num, sar_den, codec, probe_json) "
            "values (?, ?, 'img', 'image', 1, 1000000000, 0, 1, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
            (
                str(track_id),
                blob_id.digest,
                coded_w,
                coded_h,
                disp_w,
                disp_h,
                rotation,
                codec,
                json_text(probe_json),
            ),
        )
        return track_id

    def insert_clock_anchor(
        self, track_id: uuid.UUID, *, utc_instant: str, source: str, uncertainty_ms: int
    ) -> None:
        self._db.execute(
            "insert or ignore into clock_anchor (anchor_id, track_id, t_ns, utc_instant, "
            "source, uncertainty_ms) values (?, ?, 0, ?, ?, ?)",
            (str(uuid.uuid4()), str(track_id), utc_instant, source, uncertainty_ms),
        )

    # -- the spine ----------------------------------------------------------------------

    def upsert_span(self, address: EvidenceAddress) -> uuid.UUID:
        """Persist an address, or return the id of the identical one already stored.

        Deduplication is on ``span_digest``, which is a pure function of the address, so two
        stages that cite the same evidence share one row without coordinating.
        """
        self._refuse_if_tombstoned(address)
        existing = self._db.execute(
            "select span_id from evidence_span where workspace_id = ? and span_digest = ?",
            (str(self.workspace_id), address.span_digest),
        ).fetchone()
        if existing:
            return uuid.UUID(existing["span_id"])
        span_id = uuid.uuid4()
        digest_input = address.as_digest_input()
        self._db.execute(
            "insert into evidence_span (span_id, span_format_version, workspace_id, "
            "blob_sha256, track_key, t_start_ns, t_end_ns, modality, region, text_anchor, "
            "span_digest, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(span_id),
                address.span_format_version,
                str(self.workspace_id),
                address.blob_id.digest,
                address.track_key,
                address.interval.start_ns,
                address.interval.end_ns,
                str(address.modality),
                json_text(digest_input["region"]) if "region" in digest_input else None,
                json_text(digest_input["text_anchor"]) if "text_anchor" in digest_input else None,
                address.span_digest,
                utc_now_text(),
            ),
        )
        return span_id

    def span_address_columns(self, span_id: uuid.UUID) -> sqlite3.Row | None:
        return self._db.execute(
            "select * from evidence_span where span_id = ? and workspace_id = ?",
            (str(span_id), str(self.workspace_id)),
        ).fetchone()

    # -- tombstones ---------------------------------------------------------------------

    def insert_tombstone(
        self,
        *,
        scope: str,
        requested_by: uuid.UUID,
        capture_id: uuid.UUID | None = None,
        track_key: str | None = None,
        interval_ns: Sequence[tuple[int, int]] | None = None,
        reason: str | None = None,
        blocklist_hash: bool = False,
    ) -> uuid.UUID:
        tombstone_id = uuid.uuid4()
        now = utc_now_text()
        self._db.execute(
            "insert into tombstone (tombstone_id, workspace_id, scope, capture_id, track_key, "
            "interval_ns, blocklist_hash, requested_by, requested_at, effective_at, reason) "
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(tombstone_id),
                str(self.workspace_id),
                scope,
                str(capture_id) if capture_id else None,
                track_key,
                json_text([list(pair) for pair in interval_ns]) if interval_ns else None,
                int(blocklist_hash),
                str(requested_by),
                now,
                now,
                reason,
            ),
        )
        return tombstone_id

    def tombstone_blocks(
        self,
        blob_id: BlobId,
        track_key: str,
        t_start_ns: int,
        t_end_ns: int,
        *,
        assume_live_capture: bool = False,
    ) -> bool:
        """The portable half of ``tombstone_blocks_span``.

        The capture branch releases once some live capture claims these bytes again, which is
        what reconciles the guard with the re-upload rule: deleting and deliberately
        re-importing is a different intent from "never let this content back in", and only the
        latter sets ``blocklist_hash``. An interval redaction never releases, because it is a
        statement about content rather than about one import of it.

        ``assume_live_capture`` answers the question an ingest has to ask *before* it writes
        anything: "given that I am about to register a live capture for these bytes, will the
        span write be refused?" Without it the answer would be a false yes for every deliberate
        re-import, because at that instant no live capture exists yet. See
        ``refuse_ingest_if_tombstoned``.
        """
        rows = self._db.execute(
            "select t.scope, t.track_key, t.interval_ns, t.blocklist_hash, c.blob_sha256 "
            "from tombstone t left join capture c on c.capture_id = t.capture_id "
            "where t.workspace_id = ? and t.effective_at <= ?",
            (str(self.workspace_id), utc_now_text()),
        ).fetchall()
        if not rows:
            return False
        live = (
            True
            if assume_live_capture
            else self._db.execute(
                "select 1 from capture where workspace_id = ? and blob_sha256 = ? "
                "and deleted_at is null limit 1",
                (str(self.workspace_id), blob_id.digest),
            ).fetchone()
        )
        for row in rows:
            same_bytes = row["blob_sha256"] == blob_id.digest
            if row["scope"] == "workspace":
                return True
            if row["blocklist_hash"] and same_bytes:
                return True
            if row["scope"] == "capture" and same_bytes and live is None:
                return True
            if row["scope"] == "interval" and same_bytes and row["track_key"] == track_key:
                for start, end in json.loads(row["interval_ns"] or "[]"):
                    if t_start_ns < end and start < t_end_ns:
                        return True
        return False

    def refuse_ingest_if_tombstoned(self, address: EvidenceAddress) -> None:
        """The admission check an ingest runs **before it writes a single byte anywhere**.

        The object store is not in the database transaction, so a refusal discovered on the way
        out is not a refusal: the rows roll back and the bytes stay. Purged content would be
        resurrected by the very import that was correctly cancelled. The only ordering that
        makes the guarantee true is to ask first and write nothing until the answer is no.

        It asks the same question ``upsert_span`` will ask later, under the assumption this
        ingest will register a live capture for these bytes, which it will. The two therefore
        agree: this never refuses an import that ``upsert_span`` would have allowed, and never
        allows one it would have refused. The later check is not redundant, because a tombstone
        may be committed in between; it is the one that closes the race, and this one is what
        keeps the store clean in the overwhelmingly common case where there is no race at all.
        """
        self._refuse_if_tombstoned(address, assume_live_capture=True)

    def _refuse_if_tombstoned(
        self, address: EvidenceAddress, *, assume_live_capture: bool = False
    ) -> None:
        if self.tombstone_blocks(
            address.blob_id,
            address.track_key,
            address.interval.start_ns,
            address.interval.end_ns,
            assume_live_capture=assume_live_capture,
        ):
            raise TombstonedError(
                f"a committed tombstone covers {address.blob_id.ni_uri} "
                f"{address.track_key} {address.interval}. This is terminal: the job is "
                "cancelled, not retried."
            )

    # -- derivatives --------------------------------------------------------------------

    def find_artifact(self, idempotency_key: str) -> ArtifactRow | None:
        row = self._db.execute(
            "select artifact_id, kind, stage_key, stage_version, idempotency_key, "
            "content_sha256, storage_key, byte_size from artifact "
            "where workspace_id = ? and idempotency_key = ? and purged_at is null",
            (str(self.workspace_id), idempotency_key),
        ).fetchone()
        if row is None:
            return None
        return ArtifactRow(
            artifact_id=uuid.UUID(row["artifact_id"]),
            kind=row["kind"],
            stage_key=row["stage_key"],
            stage_version=row["stage_version"],
            idempotency_key=row["idempotency_key"],
            content_sha256=row["content_sha256"],
            storage_key=row["storage_key"],
            byte_size=row["byte_size"],
        )

    def insert_artifact(
        self,
        *,
        artifact_id: uuid.UUID,
        kind: str,
        source_blob: BlobId,
        stage_key: str,
        stage_version: int,
        params_digest: bytes,
        input_digest: bytes,
        idempotency_key: str,
        content_sha256: bytes,
        storage_key: str,
        byte_size: int,
        produced_by_event: uuid.UUID | None,
    ) -> bool:
        """Insert a derivative. Returns False when another worker already produced it.

        Never an update. A new ``stage_version`` produces a new row and marks the old one
        superseded, so old citations, old anchor resolutions and old Assembly Replays stay
        intact.
        """
        cursor = self._db.execute(
            "insert or ignore into artifact (artifact_id, workspace_id, kind, "
            "source_blob_sha256, stage_key, stage_version, params_digest, input_digest, "
            "idempotency_key, content_sha256, storage_key, byte_size, produced_by_event, "
            "created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(artifact_id),
                str(self.workspace_id),
                kind,
                source_blob.digest,
                stage_key,
                stage_version,
                params_digest,
                input_digest,
                idempotency_key,
                content_sha256,
                storage_key,
                byte_size,
                str(produced_by_event) if produced_by_event else None,
                utc_now_text(),
            ),
        )
        return cursor.rowcount > 0

    def mark_artifact_needs_repair(self, artifact_id: uuid.UUID) -> None:
        """Flag an artifact whose bytes are gone and cannot be reproduced.

        Set when a recompute of a stage declared deterministic does not reproduce the stored
        content hash *and* the stored bytes are absent. The row is not rewritten to point at
        the new bytes: the identity key names the old content, and quietly redefining what it
        names would make every citation and replay that used it wrong without saying so.
        """
        self._db.execute(
            "update artifact set needs_repair = 1 where workspace_id = ? and artifact_id = ?",
            (str(self.workspace_id), str(artifact_id)),
        )

    # -- epistemics ---------------------------------------------------------------------

    def predicate_id(self, key: str) -> int:
        row = self._db.execute(
            "select predicate_id from predicate where key = ?", (key,)
        ).fetchone()
        if row is None:
            raise EpistemicViolation(f"no predicate {key!r} in the vocabulary")
        return int(row["predicate_id"])

    def _check_allows_kind(self, predicate_key: str, kind: str) -> int:
        row = self._db.execute(
            "select predicate_id, allows_kind from predicate where key = ?", (predicate_key,)
        ).fetchone()
        if row is None:
            raise EpistemicViolation(f"no predicate {predicate_key!r} in the vocabulary")
        allowed = json.loads(row["allows_kind"])
        if kind not in allowed:
            raise EpistemicViolation(
                f"predicate {predicate_key!r} does not accept a {kind!r} assertion; it allows "
                f"{allowed}. A detection is an inference no matter how confident it is, and a "
                "name comes only from the account holder."
            )
        return int(row["predicate_id"])

    def insert_assertion(
        self,
        *,
        kind: str,
        predicate_key: str,
        subject_ref: dict[str, Any],
        emit_key: str,
        support_span_ids: Sequence[uuid.UUID],
        object_value: Any = None,
        object_ref: dict[str, Any] | None = None,
        produced_by_run: uuid.UUID | None = None,
        stated_by_user: uuid.UUID | None = None,
        external_source: dict[str, Any] | None = None,
        raw_score: float | None = None,
        valid_time: str | None = None,
    ) -> uuid.UUID | None:
        """Write one claim. Returns None when this ``emit_key`` was already emitted.

        ``raw_score`` is whatever the model emitted and nothing else. It is never rendered to a
        user and never thresholds a factual claim. When a model emits a qualitative band rather
        than a number, this stays None: converting a band to a number would invent a frequency
        guarantee nobody can honour.
        """
        predicate_id = self._check_allows_kind(predicate_key, kind)
        span_ids = [str(span_id) for span_id in support_span_ids]
        if kind in {"capture", "inference"} and not span_ids:
            raise EpistemicViolation(
                f"a {kind} assertion must cite at least one evidence span; "
                f"{predicate_key!r} arrived with none"
            )
        for span_id in support_span_ids:
            row = self.span_address_columns(span_id)
            if row is None:
                raise EpistemicViolation(f"support span {span_id} is not in this workspace")
            if self.tombstone_blocks(
                BlobId(row["blob_sha256"]),
                row["track_key"],
                row["t_start_ns"],
                row["t_end_ns"],
            ):
                raise TombstonedError(f"support span {span_id} is covered by a tombstone")
        assertion_id = uuid.uuid4()
        cursor = self._db.execute(
            "insert or ignore into assertion (assertion_id, workspace_id, kind, predicate_id, "
            "subject_ref, object_ref, object_value, valid_time, asserted_at, support_span_ids, "
            "produced_by_run, stated_by_user, external_source, raw_score, status, emit_key) "
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
            (
                str(assertion_id),
                str(self.workspace_id),
                kind,
                predicate_id,
                json_text(subject_ref),
                json_text(object_ref) if object_ref is not None else None,
                json_text(object_value) if object_value is not None else None,
                valid_time,
                utc_now_text(),
                json_text(span_ids),
                str(produced_by_run) if produced_by_run else None,
                str(stated_by_user) if stated_by_user else None,
                json_text(external_source) if external_source else None,
                raw_score,
                emit_key,
            ),
        )
        return assertion_id if cursor.rowcount > 0 else None

    def insert_occurrence(
        self,
        *,
        capture_id: uuid.UUID,
        occurrence_class: str,
        primary_span_id: uuid.UUID,
        span_ids: Sequence[uuid.UUID],
        presence: Sequence[tuple[int, int]],
        produced_by_run: uuid.UUID,
        detector_version: str,
        identity_key: bytes,
        emit_key: str,
        quality: dict[str, Any] | None = None,
    ) -> uuid.UUID | None:
        """Write a scene-local occurrence. It never carries a name, and there is no column for one.

        Promotion to an entity is a separate, user-driven event. Nothing in this method can
        create an entity or a link, which is what keeps a model's guess distinguishable from
        the user's knowledge.
        """
        occurrence_id = uuid.uuid4()
        cursor = self._db.execute(
            "insert or ignore into occurrence (occurrence_id, workspace_id, capture_id, class, "
            "primary_span_id, span_ids, presence, produced_by_run, detector_version, quality, "
            "identity_key, emit_key, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(occurrence_id),
                str(self.workspace_id),
                str(capture_id),
                occurrence_class,
                str(primary_span_id),
                json_text([str(span_id) for span_id in span_ids]),
                json_text([list(pair) for pair in presence]),
                str(produced_by_run),
                detector_version,
                json_text(quality) if quality else None,
                identity_key,
                emit_key,
                utc_now_text(),
            ),
        )
        return occurrence_id if cursor.rowcount > 0 else None

    def upsert_derived_artifact(
        self,
        *,
        derived_id: uuid.UUID,
        kind: str,
        depends_on: list[dict[str, Any]],
        dep_index: list[str],
        source_ids: Sequence[uuid.UUID],
        payload: dict[str, Any],
    ) -> bool:
        """A derived object that records what it was computed from.

        ``source_ids`` is not optional in spirit: a generated summary that does not record the
        ids it was conditioned on cannot be invalidated when one of them is deleted, and the
        name survives its own deletion inside a caption.
        """
        cursor = self._db.execute(
            "insert or ignore into derived_artifact (derived_id, workspace_id, kind, "
            "depends_on, dep_index, source_ids, payload, computed_at, stale) "
            "values (?, ?, ?, ?, ?, ?, ?, ?, 0)",
            (
                str(derived_id),
                str(self.workspace_id),
                kind,
                json_text(depends_on),
                json_text(dep_index),
                json_text([str(source_id) for source_id in source_ids]),
                json_text(payload),
                utc_now_text(),
            ),
        )
        return cursor.rowcount > 0

    # -- reads used by scene grouping and the CLI ---------------------------------------

    def captures_with_context(self) -> list[dict[str, Any]]:
        """Every live capture with its clock anchor and probe, ordered by wall clock.

        Captures with no timestamp sort last and deterministically, by capture id, so a scene
        grouping run over the same corpus produces the same groups every time.
        """
        rows = self._db.execute(
            "select c.capture_id, c.blob_sha256, c.started_at, t.probe_json, "
            "       a.utc_instant, a.source, a.uncertainty_ms "
            "from capture c "
            "join media_track t on t.blob_sha256 = c.blob_sha256 and t.track_key = 'img' "
            "left join clock_anchor a on a.track_id = t.track_id "
            "where c.workspace_id = ? and c.deleted_at is null "
            "order by coalesce(a.utc_instant, '9999'), c.capture_id",
            (str(self.workspace_id),),
        ).fetchall()
        captures: list[dict[str, Any]] = []
        for row in rows:
            probe = json.loads(row["probe_json"])
            captures.append(
                {
                    "capture_id": uuid.UUID(row["capture_id"]),
                    "blob_id": BlobId(row["blob_sha256"]),
                    "utc_instant": row["utc_instant"],
                    "clock_source": row["source"],
                    "uncertainty_ms": row["uncertainty_ms"],
                    "gps": probe.get("gps"),
                }
            )
        return captures

    def vision_payloads_by_blob(self) -> dict[str, dict[str, Any]]:
        """Vision artifacts keyed by source blob hex, read back for scene grouping."""
        rows = self._db.execute(
            "select source_blob_sha256, storage_key, artifact_id from artifact "
            "where workspace_id = ? and stage_key = 'vision' and purged_at is null",
            (str(self.workspace_id),),
        ).fetchall()
        return {
            bytes(row["source_blob_sha256"]).hex(): {
                "storage_key": row["storage_key"],
                "artifact_id": uuid.UUID(row["artifact_id"]),
            }
            for row in rows
        }

    def place_inferences_for_captures(
        self, capture_ids: Sequence[uuid.UUID]
    ) -> list[dict[str, Any]]:
        """Active ``place_is`` inference assertions for these captures, with their support.

        Read back from the assertion table rather than from the vision artifacts, so a place
        proposal is built from what was actually persisted as a claim. If a claim was refused
        at write time, it cannot vote.
        """
        if not capture_ids:
            return []
        placeholders = ",".join("?" for _ in capture_ids)
        rows = self._db.execute(
            "select a.assertion_id, a.object_value, a.subject_ref, a.support_span_ids "
            "from assertion a join predicate p on p.predicate_id = a.predicate_id "
            "where a.workspace_id = ? and p.key = 'place_is' and a.kind = 'inference' "
            "and a.status = 'active' and json_extract(a.subject_ref, '$.id') in "
            f"({placeholders}) order by a.assertion_id",
            (str(self.workspace_id), *[str(c) for c in capture_ids]),
        ).fetchall()
        return [
            {
                "assertion_id": uuid.UUID(row["assertion_id"]),
                "label": json.loads(row["object_value"]),
                "capture_id": uuid.UUID(json.loads(row["subject_ref"])["id"]),
                "support_span_ids": json.loads(row["support_span_ids"]),
            }
            for row in rows
        ]

    def count(self, table: str) -> int:
        """Row counts, for the CLI summary and for tests. Table name is not user input."""
        if table not in {
            "blob",
            "capture",
            "media_track",
            "clock_anchor",
            "evidence_span",
            "artifact",
            "assertion",
            "occurrence",
            "derived_artifact",
            "pipeline_run",
            "pipeline_event",
        }:
            raise ValueError(f"not a countable table: {table!r}")
        return int(self._db.execute(f"select count(*) as n from {table}").fetchone()["n"])

"""The ingest data layer, over the spine in ``orimera/migrations/0001_spine.sql``.

There is one schema and this module writes it. There used to be two: a portable SQLite mirror
carried the fourteen tables the photograph path needed, because no PostgreSQL with pgvector was
available when ingestion was written. The mirror is gone, and with it the parts of this module
that reimplemented in Python what the database already enforces.

What that deletion actually changed, because "we moved to Postgres" understates it:

*   **The tombstone guard is now a trigger inside the writing transaction.** The mirror could
    not express it, so this class checked in application code and the check was necessarily
    time-of-check-to-time-of-use racy. ``tombstone_blocks_span()`` is called by
    ``tg_tombstone_guard_span`` and friends on the same row being written, and it is VOLATILE
    so it takes a fresh snapshot rather than reusing the statement's. The application check
    that remains, :meth:`refuse_ingest_if_tombstoned`, is not a duplicate of it: it runs
    **before any bytes reach the object store**, which is the one thing a trigger cannot do,
    because the store is not in the transaction.
*   **Row-level security is real.** Every table this module writes except ``blob``,
    ``media_track`` and ``clock_anchor`` is under FORCE row-level security keyed on
    ``current_workspace()``. The connection must have declared a workspace; see
    :mod:`orimera.db.session` for why the constructor insists on it rather than trusting the
    caller.
*   **``predicate.allows_kind`` is enforced by the database.** The check that remains here
    exists for the error message, which names the rule and the reason, not for the guarantee.
    ``tg_assertion_kind_is_allowed()`` refuses the same write with an SQLSTATE and no
    explanation, and it refuses it on routes that never come through this class.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg.types.multirange import Multirange
from psycopg.types.range import Range

from orimera.db.guards import terminal_if_tombstoned
from orimera.db.session import set_workspace
from orimera.epistemics.assertions import AssertionWriter
from orimera.errors import TombstonedError
from orimera.evidence import EvidenceAddress
from orimera.evidence.blob import BlobId

__all__ = ["ArtifactRow", "CaptureRow", "IngestRepository"]

#: Tables ``count()`` will report on. Not user input, and not a general escape hatch: the name
#: is interpolated into SQL, so the allowlist is the only thing standing between this and an
#: injection.
_COUNTABLE = frozenset(
    {
        "artifact",
        "assertion",
        "blob",
        "capture",
        "clock_anchor",
        "derived_artifact",
        "entity",
        "entity_link",
        "evidence_span",
        "media_track",
        "occurrence",
        "pipeline_event",
        "pipeline_run",
    }
)


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


def _iso(value: Any) -> str | None:
    """Render a ``timestamptz`` as ISO 8601, or pass through what is already a string.

    Connections are pinned to UTC, so this is a UTC rendering and the field names that call it
    ``utc`` are telling the truth.
    """
    return None if value is None else (value if isinstance(value, str) else value.isoformat())


def _multirange(intervals: Sequence[tuple[int, int]]) -> Multirange:
    return Multirange([Range(start, end, "[)") for start, end in intervals])


class IngestRepository:
    """Everything the ingest path reads and writes, in one place."""

    def __init__(self, connection: psycopg.Connection, workspace_id: uuid.UUID) -> None:
        self._db = connection
        self._db.row_factory = dict_row
        self.workspace_id = workspace_id
        # Declared here as well as in Database.session, because the guards do not merely read
        # the setting, they assert it matches the row being written. A repository handed a
        # connection that was never scoped, or was scoped to a different workspace, would fail
        # on the first guarded insert with an SQLSTATE about privileges. Setting it here makes
        # the class correct standing alone and makes that failure impossible rather than
        # confusing.
        set_workspace(connection, workspace_id)
        self._assertions = AssertionWriter(connection, workspace_id)

    @property
    def assertions(self) -> AssertionWriter:
        """The shared assertion writer, for callers that need more than ``insert_assertion``."""
        return self._assertions

    @property
    def connection(self) -> psycopg.Connection:
        """The live connection. The ledger writes through it, inside the same transaction."""
        return self._db

    def register_stages(self, specs: Mapping[str, Any]) -> None:
        """Record the stage registry, so the ledger can be read without the source code."""
        for key, spec in specs.items():
            self._db.execute(
                "insert into stage_registry (stage_key, current_version, model_ref, "
                "params_schema, deterministic, output_kind, updated_at) "
                "values (%s, %s, %s, %s, %s, %s, now()) "
                "on conflict (stage_key) do update set "
                "current_version = excluded.current_version, model_ref = excluded.model_ref, "
                "params_schema = excluded.params_schema, "
                "deterministic = excluded.deterministic, "
                "output_kind = excluded.output_kind, updated_at = excluded.updated_at",
                (
                    key,
                    spec.version,
                    Jsonb({"role": spec.model_role}) if spec.model_role else None,
                    Jsonb(spec.params),
                    spec.deterministic,
                    spec.output_kind,
                ),
            )

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Connection]:
        """One stage's writes land together or not at all.

        This is half of the producer protocol: the artifact row, its assertions and its ledger
        event share a transaction, and every emitted row carries a deterministic emit key under
        a unique constraint. A worker that dies halfway and is retried produces the same keys,
        the conflicts absorb the duplicates, and the effect is exactly once on top of
        at-least-once execution.
        """
        with self._db.transaction():
            yield self._db

    # -- media layer --------------------------------------------------------------------

    def upsert_blob(
        self, blob_id: BlobId, *, byte_size: int, media_type: str, storage_key: str
    ) -> bool:
        """Register bytes. Returns True when the database had not seen them before."""
        cursor = self._db.execute(
            "insert into blob (blob_sha256, byte_size, media_type, storage_key) "
            "values (%s, %s, %s, %s) on conflict (blob_sha256) do nothing",
            (blob_id.digest, byte_size, media_type, storage_key),
        )
        return cursor.rowcount > 0

    def live_capture_for_blob(self, blob_id: BlobId) -> CaptureRow | None:
        row = self._db.execute(
            "select capture_id, blob_sha256, device_id, started_at, deleted_at from capture "
            "where workspace_id = %s and blob_sha256 = %s and deleted_at is null",
            (self.workspace_id, blob_id.digest),
        ).fetchone()
        return self._capture_row(row) if row else None

    @staticmethod
    def _capture_row(row: Mapping[str, Any]) -> CaptureRow:
        return CaptureRow(
            capture_id=row["capture_id"],
            blob_id=BlobId(bytes(row["blob_sha256"])),
            device_id=row["device_id"],
            started_at=_iso(row["started_at"]),
            deleted_at=_iso(row["deleted_at"]),
        )

    def insert_capture(
        self, blob_id: BlobId, *, device_id: str | None, started_at: str | None
    ) -> CaptureRow:
        row = self._db.execute(
            "insert into capture (workspace_id, blob_sha256, device_id, started_at) "
            "values (%s, %s, %s, %s) returning capture_id",
            (self.workspace_id, blob_id.digest, device_id, started_at),
        ).fetchone()
        assert row is not None
        return CaptureRow(
            capture_id=row["capture_id"],
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
        row = self._db.execute(
            "insert into media_track (blob_sha256, track_key, kind, time_base_num, "
            "time_base_den, start_pts, duration_ns, coded_w, coded_h, disp_w, disp_h, rotation, "
            "sar_num, sar_den, codec, probe_json) "
            "values (%s, 'img', 'image', 1, 1000000000, 0, 1, %s, %s, %s, %s, %s, 1, 1, %s, %s) "
            "on conflict (blob_sha256, track_key) do nothing returning track_id",
            (
                blob_id.digest,
                coded_w,
                coded_h,
                disp_w,
                disp_h,
                rotation,
                codec,
                Jsonb(probe_json),
            ),
        ).fetchone()
        if row is not None:
            return row["track_id"]
        existing = self._db.execute(
            "select track_id from media_track where blob_sha256 = %s and track_key = 'img'",
            (blob_id.digest,),
        ).fetchone()
        assert existing is not None
        return existing["track_id"]

    def insert_clock_anchor(
        self, track_id: uuid.UUID, *, utc_instant: str, source: str, uncertainty_ms: int
    ) -> None:
        self._db.execute(
            "insert into clock_anchor (track_id, t_ns, utc_instant, source, uncertainty_ms) "
            "values (%s, 0, %s, %s, %s) on conflict (track_id, t_ns, source) do nothing",
            (track_id, utc_instant, source, uncertainty_ms),
        )

    # -- the spine ----------------------------------------------------------------------

    def upsert_span(self, address: EvidenceAddress) -> uuid.UUID:
        """Persist an address, or return the id of the identical one already stored.

        Deduplication is on ``span_digest``, which is a pure function of the address, so two
        stages that cite the same evidence share one row without coordinating. The insert is
        attempted first and the read is the fallback, rather than the other way round, because
        read-then-insert loses the race to a concurrent writer and this does not.
        """
        digest_input = address.as_digest_input()
        with terminal_if_tombstoned():
            row = self._db.execute(
                "insert into evidence_span (span_format_version, workspace_id, blob_sha256, "
                "track_key, t_start_ns, t_end_ns, modality, region, text_anchor, span_digest) "
                "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "on conflict (workspace_id, span_digest) do nothing returning span_id",
                (
                    address.span_format_version,
                    self.workspace_id,
                    address.blob_id.digest,
                    address.track_key,
                    address.interval.start_ns,
                    address.interval.end_ns,
                    str(address.modality),
                    Jsonb(digest_input["region"]) if "region" in digest_input else None,
                    Jsonb(digest_input["text_anchor"]) if "text_anchor" in digest_input else None,
                    address.span_digest,
                ),
            ).fetchone()
        if row is not None:
            return row["span_id"]
        existing = self._db.execute(
            "select span_id from evidence_span where workspace_id = %s and span_digest = %s",
            (self.workspace_id, address.span_digest),
        ).fetchone()
        assert existing is not None
        return existing["span_id"]

    def span_address_columns(self, span_id: uuid.UUID) -> dict[str, Any] | None:
        return self._db.execute(
            "select * from evidence_span where span_id = %s and workspace_id = %s",
            (span_id, self.workspace_id),
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
        row = self._db.execute(
            "insert into tombstone (workspace_id, scope, capture_id, track_key, interval_ns, "
            "blocklist_hash, requested_by, reason) "
            "values (%s, %s, %s, %s, %s::int8multirange, %s, %s, %s) returning tombstone_id",
            (
                self.workspace_id,
                scope,
                capture_id,
                track_key,
                _multirange(interval_ns) if interval_ns else None,
                blocklist_hash,
                requested_by,
                reason,
            ),
        ).fetchone()
        assert row is not None
        return row["tombstone_id"]

    def tombstone_blocks(
        self,
        blob_id: BlobId,
        track_key: str,
        t_start_ns: int,
        t_end_ns: int,
        *,
        assume_live_capture: bool = False,
    ) -> bool:
        """Ask the database the question its own write guards ask.

        ``tombstone_blocks_span`` is the function the ``before insert`` triggers call, so this
        cannot disagree with what the database will do; there is one implementation of the rule
        and it is in SQL.

        ``assume_live_capture`` selects the admission variant,
        ``tombstone_admits_new_capture``, which answers the question an ingest has to ask
        *before* it writes anything: "given that I am about to register a live capture for
        these bytes, will the span write be refused?" Without it the answer would be a false
        yes for every deliberate re-import, because at that instant no live capture exists yet.
        """
        function = (
            "not tombstone_admits_new_capture" if assume_live_capture else "tombstone_blocks_span"
        )
        row = self._db.execute(
            f"select {function}(%s, %s, %s, %s, %s) as blocked",
            (self.workspace_id, blob_id.digest, track_key, t_start_ns, t_end_ns),
        ).fetchone()
        assert row is not None
        return bool(row["blocked"])

    def refuse_ingest_if_tombstoned(self, address: EvidenceAddress) -> None:
        """The admission check an ingest runs **before it writes a single byte anywhere**.

        The object store is not in the database transaction, so a refusal discovered on the way
        out is not a refusal: the rows roll back and the bytes stay. Purged content would be
        resurrected by the very import that was correctly cancelled. The only ordering that
        makes the guarantee true is to ask first and write nothing until the answer is no.

        It asks the same question the ``before insert`` trigger on ``evidence_span`` will ask
        later, under the assumption this ingest will register a live capture for these bytes,
        which it will. The two therefore agree: this never refuses an import the trigger would
        have allowed, and never allows one it would have refused. The trigger is not redundant,
        because a tombstone may be committed in between; it is the one that closes the race,
        and this one is what keeps the store clean in the overwhelmingly common case where
        there is no race at all.
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
            "where workspace_id = %s and idempotency_key = %s and purged_at is null",
            (self.workspace_id, idempotency_key),
        ).fetchone()
        if row is None:
            return None
        return ArtifactRow(
            artifact_id=row["artifact_id"],
            kind=row["kind"],
            stage_key=row["stage_key"],
            stage_version=row["stage_version"],
            idempotency_key=row["idempotency_key"],
            content_sha256=bytes(row["content_sha256"]) if row["content_sha256"] else None,
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
        # TERMINAL, like every other write the tombstone guards cover. Migration 0011 refuses a
        # derivative of tombstoned bytes, and without this translation the refusal surfaces as an
        # ordinary integrity error: the run is recorded as FAILED, and a failed run is one a
        # worker retries, which is an unbounded loop against a photograph the user deleted.
        with terminal_if_tombstoned():
            cursor = self._db.execute(
                "insert into artifact (artifact_id, workspace_id, kind, source_blob_sha256, "
                "stage_key, stage_version, params_digest, input_digest, idempotency_key, "
                "content_sha256, storage_key, byte_size, produced_by_event) "
                "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "on conflict (workspace_id, idempotency_key) do nothing",
                (
                    artifact_id,
                    self.workspace_id,
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
                    produced_by_event,
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
            "update artifact set needs_repair = true "
            "where workspace_id = %s and artifact_id = %s",
            (self.workspace_id, artifact_id),
        )

    # -- epistemics ---------------------------------------------------------------------
    #
    # Delegated rather than reimplemented. The identity path writes the kind='user' naming
    # assertion that entity.display_name depends on, and it must not reach through this class
    # to do it: two implementations of "insert an assertion" would be two places for the
    # support-span rule and the allows-kind check to drift.

    def predicate_id(self, key: str) -> int:
        return self._assertions.predicate_id(key)

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
        """Write one claim. Returns None when this ``emit_key`` was already emitted."""
        return self._assertions.insert(
            kind=kind,
            predicate_key=predicate_key,
            subject_ref=subject_ref,
            emit_key=emit_key,
            support_span_ids=support_span_ids,
            object_value=object_value,
            object_ref=object_ref,
            produced_by_run=produced_by_run,
            stated_by_user=stated_by_user,
            external_source=external_source,
            raw_score=raw_score,
            valid_time=valid_time,
        )

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
        with terminal_if_tombstoned():
            row = self._db.execute(
                "insert into occurrence (workspace_id, capture_id, class, primary_span_id, "
                "span_ids, presence, produced_by_run, detector_version, quality, identity_key, "
                "emit_key) values (%s, %s, %s, %s, %s::uuid[], %s::int8multirange, %s, %s, %s, "
                "%s, %s) on conflict (workspace_id, emit_key) do nothing returning occurrence_id",
                (
                    self.workspace_id,
                    capture_id,
                    occurrence_class,
                    primary_span_id,
                    list(span_ids),
                    _multirange(presence),
                    produced_by_run,
                    detector_version,
                    Jsonb(quality) if quality else None,
                    identity_key,
                    emit_key,
                ),
            ).fetchone()
        return row["occurrence_id"] if row is not None else None

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
            "insert into derived_artifact (derived_id, workspace_id, kind, depends_on, "
            "dep_index, source_ids, payload, stale) "
            "values (%s, %s, %s, %s, %s::text[], %s::uuid[], %s, false) "
            "on conflict (derived_id) do nothing",
            (
                derived_id,
                self.workspace_id,
                kind,
                Jsonb(depends_on),
                list(dep_index),
                list(source_ids),
                Jsonb(payload),
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
            "where c.workspace_id = %s and c.deleted_at is null "
            "order by coalesce(a.utc_instant, 'infinity'::timestamptz), c.capture_id",
            (self.workspace_id,),
        ).fetchall()
        return [
            {
                "capture_id": row["capture_id"],
                "blob_id": BlobId(bytes(row["blob_sha256"])),
                "utc_instant": _iso(row["utc_instant"]),
                "clock_source": row["source"],
                "uncertainty_ms": row["uncertainty_ms"],
                "gps": (row["probe_json"] or {}).get("gps"),
            }
            for row in rows
        ]

    def vision_payloads_by_blob(self) -> dict[str, dict[str, Any]]:
        """Vision artifacts keyed by source blob hex, read back for scene grouping."""
        rows = self._db.execute(
            "select source_blob_sha256, storage_key, artifact_id from artifact "
            "where workspace_id = %s and stage_key = 'vision' and purged_at is null",
            (self.workspace_id,),
        ).fetchall()
        return {
            bytes(row["source_blob_sha256"]).hex(): {
                "storage_key": row["storage_key"],
                "artifact_id": row["artifact_id"],
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
        rows = self._db.execute(
            "select a.assertion_id, a.object_value, a.subject_ref, a.support_span_ids "
            "from assertion a join predicate p on p.predicate_id = a.predicate_id "
            "where a.workspace_id = %s and p.key = 'place_is' and a.kind = 'inference' "
            "and a.status = 'active' and a.subject_ref->>'id' = any(%s::text[]) "
            "order by a.assertion_id",
            (self.workspace_id, [str(c) for c in capture_ids]),
        ).fetchall()
        return [
            {
                "assertion_id": row["assertion_id"],
                "label": row["object_value"],
                "capture_id": uuid.UUID(row["subject_ref"]["id"]),
                "support_span_ids": list(row["support_span_ids"]),
            }
            for row in rows
        ]

    def count(self, table: str) -> int:
        """Row counts, for the CLI summary and for tests. Table name is not user input."""
        if table not in _COUNTABLE:
            raise ValueError(f"not a countable table: {table!r}")
        row = self._db.execute(f"select count(*) as n from {table}").fetchone()
        assert row is not None
        return int(row["n"])

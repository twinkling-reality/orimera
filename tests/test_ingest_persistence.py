"""What ends up persisted, and under which provenance class.

Four things are checked here, and each one is an invariant that a plausible-looking pipeline
gets wrong:

*   Capture-supported observation, model inference and user statement are three different
    things. A caption filed as a capture fact is a guess rendered as a measurement.
*   Every evidence address resolves back to the original bytes, and a span read out of the
    database rebuilds to the same digest it was stored under.
*   The ledger records what actually happened, in enough detail that the Assembly Replay does
    not have to read the source code.
*   A tombstoned address refuses the write, terminally.
"""

from __future__ import annotations

import ast
import dataclasses
import json
import pathlib
import uuid

import pytest
from orimera.evidence import Modality
from orimera.ingest import pipeline as pipeline_module
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.ingest.repository import EpistemicViolation, IngestRepository, TombstonedError
from orimera.ingest.resolve import (
    address_from_span_row,
    resolve_original_bytes,
    resolve_region_image,
)
from orimera.store.base import PurgeAuthorization, privileged_purger
from orimera.store.local import LocalContentAddressedStore

from conftest import CountingVisionModel, write_photo


@pytest.fixture
def ingested(tmp_path, photo_dir, workspace_id):
    path = write_photo(photo_dir, "a.jpg", gps=(64.3271, -20.1199))
    repository = IngestRepository.open(tmp_path / "ingest.db", workspace_id)
    store = LocalContentAddressedStore(tmp_path / "blobs")
    vision = CountingVisionModel()
    pipeline = PhotoIngestPipeline(repository, store, vision=vision)
    outcome = pipeline.ingest_file(path)
    assert outcome.error is None
    return repository, store, pipeline, path, outcome


def _assertions(repository):
    rows = repository.connection.execute(
        "select a.kind, p.key, a.object_value, a.support_span_ids, a.produced_by_run, "
        "a.raw_score, a.stated_by_user from assertion a "
        "join predicate p on p.predicate_id = a.predicate_id"
    ).fetchall()
    return [dict(row) for row in rows]


# -- epistemic status -------------------------------------------------------------------


def test_exif_facts_are_capture_and_model_output_is_inference(ingested):
    repository, *_ = ingested
    by_predicate = {row["key"]: row for row in _assertions(repository)}

    for key in ("captured_at", "device_model_is", "gps_position_is", "pixel_size_is"):
        assert by_predicate[key]["kind"] == "capture", key
    for key in ("caption_is", "object_present", "ocr_text_is", "place_is"):
        assert by_predicate[key]["kind"] == "inference", key


def test_every_assertion_cites_evidence_and_every_inference_names_its_run(ingested):
    repository, *_ = ingested
    for row in _assertions(repository):
        assert json.loads(row["support_span_ids"]), f"{row['key']} cites nothing"
        if row["kind"] == "inference":
            assert row["produced_by_run"] is not None, row["key"]


def test_a_model_score_is_never_invented_from_a_confidence_band(ingested):
    """The model emitted 'high', not 0.9. Turning a band into a number invents a frequency."""
    repository, *_ = ingested
    for row in _assertions(repository):
        assert row["raw_score"] is None
    quality = repository.connection.execute(
        "select quality from occurrence where class = 'object'"
    ).fetchone()
    assert json.loads(quality["quality"])["confidence_band"] in {"low", "medium", "high"}


def test_a_caption_cannot_be_filed_as_a_capture_supported_fact(ingested):
    """The data layer refuses it. This is the collapse that lets a guess render as a fact."""
    repository, *_ = ingested
    span_id = uuid.UUID(
        repository.connection.execute("select span_id from evidence_span limit 1").fetchone()[
            "span_id"
        ]
    )
    with pytest.raises(EpistemicViolation, match="does not accept a 'capture'"):
        repository.insert_assertion(
            kind="capture",
            predicate_key="caption_is",
            subject_ref={"type": "capture", "id": str(uuid.uuid4())},
            object_value="a waterfall",
            emit_key="test:1",
            support_span_ids=[span_id],
        )


def test_no_model_can_write_a_name(ingested):
    """``name_is`` allows only ``user``. There is no code path in which a model writes a name."""
    repository, *_ = ingested
    span_id = uuid.UUID(
        repository.connection.execute("select span_id from evidence_span limit 1").fetchone()[
            "span_id"
        ]
    )
    for kind in ("inference", "capture", "external"):
        with pytest.raises(EpistemicViolation):
            repository.insert_assertion(
                kind=kind,
                predicate_key="name_is",
                subject_ref={"type": "entity", "id": str(uuid.uuid4())},
                object_value="Anna",
                emit_key=f"test:name:{kind}",
                support_span_ids=[span_id],
                produced_by_run=uuid.uuid4(),
            )


def test_people_are_recorded_but_never_promoted_to_an_occurrence(ingested):
    """Q-H6, when a biometric embedding may exist at all, is OPEN. Identity work waits for it.

    The model reported a person. That is kept in the observation artifact so nothing is
    silently dropped, and it does not become an occurrence, an entity or an embedding.
    """
    repository, store, *_ = ingested
    classes = {
        row["class"]
        for row in repository.connection.execute("select class from occurrence").fetchall()
    }
    assert "person" not in classes

    row = repository.connection.execute(
        "select content_sha256 from artifact where stage_key = 'vision'"
    ).fetchone()
    from orimera.evidence.blob import BlobId

    document = json.loads(store.get(BlobId(row["content_sha256"])))
    assert document["person_labels_not_promoted"] == ["person"]
    assert document["header"]["trust_tier"] == "T2"
    assert document["header"]["epistemic_class"] == "inference"


def test_the_ingest_schema_has_no_entity_table_at_all(ingested):
    """Invariant 3, enforced by absence rather than by discipline."""
    repository, *_ = ingested
    tables = {
        row["name"]
        for row in repository.connection.execute(
            "select name from sqlite_master where type = 'table'"
        ).fetchall()
    }
    assert "entity" not in tables and "entity_link" not in tables


# -- addresses resolve ------------------------------------------------------------------


def test_every_span_rebuilds_to_the_digest_it_was_stored_under(ingested):
    repository, *_ = ingested
    rows = repository.connection.execute("select * from evidence_span").fetchall()
    assert rows
    for row in rows:
        address = address_from_span_row(row)  # raises if the digest does not match
        assert address.to_uri()


def test_an_address_resolves_to_the_original_bytes_not_to_a_rendition(ingested):
    repository, store, _pipeline, path, _outcome = ingested
    row = repository.connection.execute(
        "select * from evidence_span where modality = 'still_image'"
    ).fetchone()
    address = address_from_span_row(row)
    assert address.modality is Modality.STILL_IMAGE
    assert resolve_original_bytes(address, store) == path.read_bytes()


def test_a_region_address_crops_the_upright_original(ingested):
    """The region was normalised against display space, so the crop must apply orientation."""
    repository, store, *_ = ingested
    row = repository.connection.execute(
        "select * from evidence_span where modality = 'frame_region' limit 1"
    ).fetchone()
    address = address_from_span_row(row)
    cropped = resolve_region_image(address, store)
    assert cropped.size[0] > 0 and cropped.size[1] > 0
    assert cropped.size[0] < 160  # a region, not the whole photograph


def test_a_photograph_carries_the_degenerate_interval_and_the_img_track(ingested):
    repository, *_ = ingested
    row = repository.connection.execute("select * from evidence_span limit 1").fetchone()
    assert (row["t_start_ns"], row["t_end_ns"]) == (0, 1)
    assert row["track_key"] == "img"
    track = repository.connection.execute("select * from media_track").fetchone()
    assert (track["time_base_num"], track["time_base_den"]) == (1, 1_000_000_000)
    assert track["duration_ns"] == 1


def test_wall_clock_lives_in_a_clock_anchor_with_its_uncertainty(ingested):
    repository, *_ = ingested
    anchor = repository.connection.execute("select * from clock_anchor").fetchone()
    assert anchor["source"] == "container_creation_time"
    assert anchor["uncertainty_ms"] > 0
    assert anchor["t_ns"] == 0


def test_an_exif_timestamp_with_no_zone_carries_the_size_of_that_unknown(
    tmp_path, photo_dir, workspace_id
):
    from orimera.ingest.exif import UNKNOWN_OFFSET_UNCERTAINTY_MS

    path = write_photo(photo_dir, "nozone.jpg", offset=None)
    repository = IngestRepository.open(tmp_path / "ingest.db", workspace_id)
    store = LocalContentAddressedStore(tmp_path / "blobs")
    PhotoIngestPipeline(repository, store).ingest_file(path)
    anchor = repository.connection.execute("select * from clock_anchor").fetchone()
    assert anchor["uncertainty_ms"] == UNKNOWN_OFFSET_UNCERTAINTY_MS


# -- the ledger -------------------------------------------------------------------------


def _events(repository, run_id):
    return [
        dict(row)
        for row in repository.connection.execute(
            "select * from pipeline_event where run_id = ? order by seq", (str(run_id),)
        ).fetchall()
    ]


def test_the_ledger_records_every_stage_with_timing_and_its_inputs(ingested):
    repository, _store, _pipeline, _path, outcome = ingested
    events = _events(repository, outcome.run_id)
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1)), "seq must be gapless"

    started = {e["stage_key"]: e for e in events if e["type"] == "stage_started"}
    assert set(started) == {"intake", "rendition", "vision"}
    # input_artifact_ids is recorded, not implied by the shape of the code.
    assert json.loads(started["rendition"]["input_artifact_ids"])
    assert json.loads(started["vision"]["input_artifact_ids"])
    assert json.loads(started["intake"]["input_artifact_ids"]) == []

    for event in (e for e in events if e["type"] == "stage_succeeded"):
        assert event["duration_ms"] is not None
        assert event["started_at"] and event["ended_at"]
        assert event["params_digest"] is not None


def test_the_ledger_records_the_model_and_its_token_usage(ingested):
    repository, _store, _pipeline, _path, outcome = ingested
    vision = next(
        e
        for e in _events(repository, outcome.run_id)
        if e["type"] == "stage_succeeded" and e["stage_key"] == "vision"
    )
    cost = json.loads(vision["cost"])
    assert cost["input_tokens"] == 772 and cost["output_tokens"] == 210
    assert json.loads(vision["model_ref"])["model_id"] == "MiniMaxAI/MiniMax-M3"


def test_the_ledger_records_the_prompt_and_schema_version_in_the_artifact_it_points_at(
    ingested,
):
    """The replay must be able to answer 'which prompt produced this' without the source."""
    repository, store, *_ = ingested
    from orimera.evidence.blob import BlobId
    from orimera.ingest.vision import PROMPT_VERSION, SCHEMA_VERSION, prompt_digest

    row = repository.connection.execute(
        "select content_sha256 from artifact where stage_key = 'vision'"
    ).fetchone()
    header = json.loads(store.get(BlobId(row["content_sha256"])))["header"]
    assert header["prompt_version"] == PROMPT_VERSION
    assert header["schema_version"] == SCHEMA_VERSION
    assert header["prompt_sha256"] == prompt_digest()


def test_a_failed_stage_is_recorded_as_failed_with_its_error_class(
    tmp_path, photo_dir, workspace_id
):
    class Exploding:
        model_id = "MiniMaxAI/MiniMax-M3"

        def observe(self, *, image_bytes, media_type):
            raise RuntimeError("the endpoint said no")

    path = write_photo(photo_dir, "a.jpg")
    repository = IngestRepository.open(tmp_path / "ingest.db", workspace_id)
    store = LocalContentAddressedStore(tmp_path / "blobs")
    outcome = PhotoIngestPipeline(repository, store, vision=Exploding()).ingest_file(path)

    assert outcome.error is not None
    events = _events(repository, outcome.run_id)
    failed = next(e for e in events if e["type"] == "stage_failed")
    assert failed["stage_key"] == "vision"
    assert failed["error_class"] == "RuntimeError"
    assert "the endpoint said no" in failed["error_message"]
    assert events[-1]["type"] == "run_failed"
    # The intake stage still committed: a failed inference does not undo a capture-supported
    # record that was already true.
    assert repository.count("capture") == 1


# -- deletion ---------------------------------------------------------------------------


def _delete_capture(repository, **tombstone_kwargs):
    """Soft-delete the one capture and commit a tombstone. Returns both ids."""
    capture_id = uuid.UUID(
        repository.connection.execute("select capture_id from capture").fetchone()["capture_id"]
    )
    repository.connection.execute(
        "update capture set deleted_at = ? where capture_id = ?",
        ("2026-08-27T12:00:00+00:00", str(capture_id)),
    )
    tombstone_id = repository.insert_tombstone(
        scope="capture", capture_id=capture_id, requested_by=uuid.uuid4(), **tombstone_kwargs
    )
    return capture_id, tombstone_id


def _purge_every_blob(store, tombstone_id):
    """Erase the bytes, through the only path that can: an explicit authorisation."""
    purger = privileged_purger(
        store,
        PurgeAuthorization(
            tombstone_id=str(tombstone_id),
            actor="test-operator",
            reason="the user asked for erasure and the tombstone authorises it",
        ),
    )
    for blob_id in list(store.iter_blob_ids()):
        purger.purge(blob_id)


def test_a_deliberate_re_import_after_deletion_proceeds_with_a_new_capture(ingested):
    """Decision del-3, which is easy to get backwards.

    A capture tombstone is keyed by capture id, never by blob hash. Keying it by hash would
    permanently blocklist those exact bytes, so a user who deleted something and later
    deliberately re-imported it would be silently blocked with no way to explain why. The
    re-import gets a fresh capture id and proceeds.
    """
    repository, _store, pipeline, path, _outcome = ingested
    deleted_capture, _tombstone = _delete_capture(repository, reason="user deleted it")

    outcome = pipeline.ingest_file(path)
    assert outcome.error is None
    assert outcome.capture_id != deleted_capture
    assert _events(repository, outcome.run_id)[-1]["type"] == "run_succeeded"
    live = repository.connection.execute(
        "select count(*) as n from capture where deleted_at is null"
    ).fetchone()["n"]
    assert live == 1


def test_an_explicit_hash_blocklist_refuses_the_write_and_cancels_the_run(ingested):
    """The other intent, and it needs its own explicit opt-in: never let this content back in.

    The store is checked as well as the database, and the bytes are genuinely purged first.
    An earlier version of this test asserted only that the capture row rolled back, and the
    fixture had already put the bytes in the store during the successful first ingest, so
    ``store.exists`` was True before the re-import and True after it and the assertion could
    not have failed however the pipeline behaved. It was a test of nothing.
    """
    repository, store, pipeline, path, first = ingested
    _capture, tombstone_id = _delete_capture(
        repository, reason="never again", blocklist_hash=True
    )
    _purge_every_blob(store, tombstone_id)
    assert not store.exists(first.blob_id), "the fixture must start from genuinely erased bytes"
    assert list(store.iter_blob_ids()) == []

    outcome = pipeline.ingest_file(path)

    assert outcome.error is not None and "tombstoned" in outcome.error
    assert _events(repository, outcome.run_id)[-1]["type"] == "run_cancelled"
    # The database rolled back, which was never the hard part.
    assert (
        repository.connection.execute(
            "select count(*) as n from capture where deleted_at is null"
        ).fetchone()["n"]
        == 0
    )
    # The hard part. The object store is not enrolled in that transaction, so a refusal
    # discovered after the write would leave the purged bytes sitting on disk: erasure that a
    # re-import silently undoes is not erasure.
    assert not store.exists(first.blob_id), "a refused import put the purged bytes back"
    assert list(store.iter_blob_ids()) == [], "a refused import wrote to the store at all"


_STORE_WRITE_METHODS = frozenset({"put_bytes", "put_stream", "put_file"})


def test_the_ingest_package_writes_to_the_object_store_in_exactly_one_place():
    """The ordering guarantee is structural, so it is checked structurally.

    Every payload reaches the store through ``_committed_writes``, which flushes only after the
    database transaction has committed and therefore only after the tombstone guard inside that
    transaction has passed. A second write anywhere in the ingest package reopens the hole,
    because the store is not transactional: bytes written before a refusal stay written. This
    is the same kind of source-level guard ``test_models_manifest`` uses to keep model
    identifiers out of Python source, and for the same reason, which is that a rule enforced by
    review is a rule that survives until the reviewer is busy.
    """
    package = pathlib.Path(pipeline_module.__file__).parent
    call_sites: list[str] = []
    for path in sorted(package.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            for inner in ast.walk(node):
                if (
                    isinstance(inner, ast.Call)
                    and isinstance(inner.func, ast.Attribute)
                    and inner.func.attr in _STORE_WRITE_METHODS
                ):
                    call_sites.append(f"{path.name}:{node.name}")
    assert call_sites == ["pipeline.py:_committed_writes"], (
        "the ingest package writes to the object store outside the post-commit flush: "
        f"{call_sites}. A write that happens before the tombstone guard cannot be rolled back "
        "by the transaction that refuses it."
    )


def test_a_tombstone_committed_mid_transaction_still_leaves_the_store_untouched(
    tmp_path, photo_dir, workspace_id, monkeypatch
):
    """The race the admission check cannot close, and the reason bytes are written last.

    The admission check runs before anything is written. A tombstone committed by another
    actor in the window between that check and ``upsert_span`` is caught by the guard inside
    the writing transaction instead, and the database rolls back. That rollback is only worth
    something if nothing has been written to the store yet, which is why every payload is
    queued during the transaction and flushed only after it commits.
    """
    path = write_photo(photo_dir, "a.jpg")
    repository = IngestRepository.open(tmp_path / "ingest.db", workspace_id)
    store = LocalContentAddressedStore(tmp_path / "blobs")
    pipeline = PhotoIngestPipeline(repository, store, vision=CountingVisionModel())

    def refuse(_address):
        raise TombstonedError("another actor committed a tombstone while this run was writing")

    monkeypatch.setattr(repository, "upsert_span", refuse)
    outcome = pipeline.ingest_file(path)

    assert outcome.error is not None and "tombstoned" in outcome.error
    assert repository.count("capture") == 0
    assert repository.count("blob") == 0
    assert list(store.iter_blob_ids()) == [], "the rolled-back transaction left bytes behind"


def test_an_interval_tombstone_covers_the_degenerate_photograph_interval(ingested):
    """Redacting a whole photograph is the degenerate interval redaction [0, 1)."""
    repository, *_ = ingested
    capture_id = uuid.UUID(
        repository.connection.execute("select capture_id from capture").fetchone()["capture_id"]
    )
    blob_row = repository.connection.execute("select blob_sha256 from blob").fetchone()
    from orimera.evidence.blob import BlobId

    blob_id = BlobId(blob_row["blob_sha256"])
    assert not repository.tombstone_blocks(blob_id, "img", 0, 1)
    repository.insert_tombstone(
        scope="interval",
        capture_id=capture_id,
        track_key="img",
        interval_ns=[(0, 1)],
        requested_by=uuid.uuid4(),
    )
    assert repository.tombstone_blocks(blob_id, "img", 0, 1)

    from orimera.evidence import EvidenceAddress

    with pytest.raises(TombstonedError):
        repository.upsert_span(EvidenceAddress.photograph(blob_id))


def test_a_deterministic_stage_that_changes_its_bytes_emits_an_event_and_keeps_the_old_artifact(
    tmp_path, photo_dir, workspace_id, monkeypatch
):
    """The two hashes exist to make exactly this visible rather than silent.

    ``idempotency_key`` is what the output should be, computed before running.
    ``content_sha256`` is what it turned out to be. When they disagree on a stage that claims
    determinism, the stored artifact wins, because citations and replays already point at it,
    and the disagreement is recorded rather than absorbed.
    """
    from orimera.ingest import pipeline as pipeline_module

    path = write_photo(photo_dir, "a.jpg")
    repository = IngestRepository.open(tmp_path / "ingest.db", workspace_id)
    store = LocalContentAddressedStore(tmp_path / "blobs")
    pipeline = PhotoIngestPipeline(repository, store)
    first = pipeline.ingest_file(path)
    original = repository.connection.execute(
        "select artifact_id, content_sha256 from artifact where stage_key = 'rendition'"
    ).fetchone()

    real_render = pipeline_module.render

    def wobble(upright, spec):
        rendition = real_render(upright, spec)
        return dataclasses.replace(rendition, data=rendition.data + b"\x00")

    monkeypatch.setattr(pipeline_module, "render", wobble)
    # Remove the stored bytes so the stage recomputes instead of short circuiting on the store.
    from orimera.evidence.blob import BlobId
    from orimera.store.base import PurgeAuthorization, privileged_purger

    purger = privileged_purger(
        store, PurgeAuthorization(tombstone_id="t", actor="test", reason="force a recompute")
    )
    purger.purge(BlobId(original["content_sha256"]))

    second = pipeline.ingest_file(path)
    assert second.error is None

    events = _events(repository, second.run_id)
    detected = [e for e in events if e["type"] == "nondeterminism_detected"]
    assert detected, "a deterministic stage produced different bytes and nobody said anything"
    assert original["content_sha256"].hex() in detected[0]["error_message"]

    kept = repository.connection.execute(
        "select artifact_id, content_sha256, needs_repair from artifact "
        "where stage_key = 'rendition'"
    ).fetchall()
    assert len(kept) == 1
    assert bytes(kept[0]["content_sha256"]) == bytes(original["content_sha256"])
    # The bytes are gone and this run could not reproduce them, so the row is flagged rather
    # than repointed at bytes the identity key does not name.
    assert kept[0]["needs_repair"] == 1
    assert first.run_id != second.run_id

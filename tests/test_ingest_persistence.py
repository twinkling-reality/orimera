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

These run against the real spine, which changes what several of them are able to prove. The
epistemic and tombstone guards used to be application code, because the SQLite mirror the
ingest path ran on could not express a trigger; the assertions against ``IngestRepository``
were therefore the whole guarantee. They are now the *error message*, and the guarantee is a
BEFORE trigger that refuses the same write on routes that never touch this class. So each of
those tests now makes the offending write twice: once through the repository, which must fail
with a sentence naming the rule, and once as raw SQL through the same connection, which must
fail with an SQLSTATE. Neither check subsumes the other, and the second is the one an
application bug cannot remove.
"""

from __future__ import annotations

import ast
import copy
import dataclasses
import datetime as dt
import json
import pathlib
import uuid

import psycopg
import pytest
from orimera.errors import EpistemicViolation, TombstonedError
from orimera.evidence import Modality
from orimera.ingest import pipeline as pipeline_module
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.ingest.resolve import resolve_region_image
from orimera.store.base import PurgeAuthorization, privileged_purger
from orimera.store.local import LocalContentAddressedStore
from orimera.store.resolve import address_from_span_row, resolve_original_bytes
from psycopg.types.json import Jsonb

from conftest import DEFAULT_PAYLOAD, CountingVisionModel, write_photo

# No module-level postgres marker. tests/conftest.py marks each test by the fixtures it
# actually requests, so the handful here that need no server stay runnable without one.

#: SQLSTATE 23000. Both guards raise ``integrity_constraint_violation``, so this is what a
#: refusal from the database looks like from Python, and it is deliberately narrower than
#: ``psycopg.Error``: a typo in the statement would raise a syntax error and pass a check that
#: only asked for "some database exception".
REFUSED = psycopg.errors.IntegrityConstraintViolation


@pytest.fixture
def ingested(tmp_path, photo_dir, repository):
    """One photograph through the whole pipeline, with the default observation.

    The default payload's person carries no box, which is deliberate rather than incidental:
    the boxless case is the one where a person is asserted and no occurrence is written, and it
    is the shape most of these tests want.
    """
    path = write_photo(photo_dir, "a.jpg", gps=(64.3271, -20.1199))
    store = LocalContentAddressedStore(tmp_path / "blobs")
    vision = CountingVisionModel()
    pipeline = PhotoIngestPipeline(repository, store, vision=vision)
    outcome = pipeline.ingest_file(path)
    assert outcome.error is None
    return repository, store, pipeline, path, outcome


@pytest.fixture
def ingested_with_a_person(tmp_path, photo_dir, repository):
    """The same, with the person located, so a person occurrence is actually produced."""
    payload = copy.deepcopy(DEFAULT_PAYLOAD)
    located = [entry for entry in payload["objects"] if entry["label"] == "person"]
    assert len(located) == 1, payload["objects"]
    located[0]["box"] = {"x": 0.55, "y": 0.1, "w": 0.2, "h": 0.6}

    path = write_photo(photo_dir, "a.jpg", gps=(64.3271, -20.1199))
    store = LocalContentAddressedStore(tmp_path / "blobs")
    vision = CountingVisionModel(payload=payload)
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


def _one_span_id(repository):
    row = repository.connection.execute("select span_id from evidence_span limit 1").fetchone()
    return row["span_id"]


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
        # support_span_ids is a uuid[], so it arrives as a list and there is nothing to decode.
        assert row["support_span_ids"], f"{row['key']} cites nothing"
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
    assert quality["quality"]["confidence_band"] in {"low", "medium", "high"}


def test_a_caption_cannot_be_filed_as_a_capture_supported_fact(ingested):
    """The data layer refuses it. This is the collapse that lets a guess render as a fact."""
    repository, *_ = ingested
    span_id = _one_span_id(repository)
    subject = {"type": "capture", "id": str(uuid.uuid4())}
    with pytest.raises(EpistemicViolation, match="does not accept a 'capture'"):
        repository.insert_assertion(
            kind="capture",
            predicate_key="caption_is",
            subject_ref=subject,
            object_value="a waterfall",
            emit_key="test:1",
            support_span_ids=[span_id],
        )

    # And by the database, on a route that never passes through IngestRepository at all. The
    # mirror could not express this, so the sentence above was the entire guarantee; it is now
    # the explanation, and tg_assertion_kind_is_allowed() is the guarantee.
    with (
        pytest.raises(REFUSED, match="does not accept a capture assertion"),
        repository.connection.transaction(),
    ):
        repository.connection.execute(
            "insert into assertion (workspace_id, kind, predicate_id, subject_ref, "
            "object_value, support_span_ids, emit_key) "
            "values (%s, 'capture', %s, %s, %s, %s::uuid[], 'test:raw:caption')",
            (
                repository.workspace_id,
                repository.predicate_id("caption_is"),
                Jsonb(subject),
                Jsonb("a waterfall"),
                [span_id],
            ),
        )


def test_no_model_can_write_a_name(ingested):
    """``name_is`` allows only ``user``. There is no code path in which a model writes a name."""
    repository, _store, _pipeline, _path, outcome = ingested
    span_id = _one_span_id(repository)
    name_is = repository.predicate_id("name_is")
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
        # The same row, written as raw SQL, and it names a real run and cites a real span so
        # that the epistemic class is the only thing wrong with it.
        with (
            pytest.raises(REFUSED, match=f"does not accept a {kind} assertion"),
            repository.connection.transaction(),
        ):
            repository.connection.execute(
                "insert into assertion (workspace_id, kind, predicate_id, subject_ref, "
                "object_value, support_span_ids, produced_by_run, emit_key) "
                "values (%s, %s, %s, %s, %s, %s::uuid[], %s, %s)",
                (
                    repository.workspace_id,
                    kind,
                    name_is,
                    Jsonb({"type": "entity", "id": str(uuid.uuid4())}),
                    Jsonb("Anna"),
                    [span_id],
                    outcome.run_id,
                    f"test:name:raw:{kind}",
                ),
            )


def test_a_located_person_becomes_an_occurrence_and_never_anything_more(ingested_with_a_person):
    """Invariant 3, at the exact point it is easiest to get wrong.

    A detected person IS a scene-local occurrence: it has an evidence address, so the same
    person photographed twice gives the recurrence thesis two things to connect. What it is not
    is an entity, a link, a name or an embedding, and those are four separate failures rather
    than one. The occurrence table has no column that could hold a name, which is the structural
    half; the behavioural half is that the ingest path writes none of the identity tables at
    all, which the test below this one pins.

    Q-H6, when a biometric embedding may exist at all, is still OPEN, and this does not touch
    it: no template of any kind is derived here. The distinction is the whole reason detection
    can proceed while derivation waits.
    """
    repository, store, *_ = ingested_with_a_person
    people = repository.connection.execute(
        "select primary_span_id, identity_key, quality from occurrence where class = 'person'"
    ).fetchall()
    assert len(people) == 1, people

    person = people[0]
    assert len(bytes(person["identity_key"])) == 32
    assert person["quality"]["label"] == "person"
    assert person["quality"]["trust_tier"] == "T2"

    # The occurrence points at a REGION of the photograph, not at the whole frame. Without that
    # every unlocated person in one capture shares an identity key, and rejection memory is
    # keyed on exactly that, so they would suppress each other's proposals forever.
    span = repository.connection.execute(
        "select modality, region from evidence_span where span_id = %s",
        (person["primary_span_id"],),
    ).fetchone()
    assert span["modality"] == "frame_region"
    assert span["region"] is not None

    columns = {
        row["column_name"]
        for row in repository.connection.execute(
            "select column_name from information_schema.columns "
            "where table_schema = current_schema() and table_name = 'occurrence'"
        ).fetchall()
    }
    assert "display_name" not in columns
    assert not any("name" in column for column in columns), sorted(columns)

    row = repository.connection.execute(
        "select content_sha256 from artifact where stage_key = 'vision'"
    ).fetchone()
    from orimera.evidence.blob import BlobId

    document = json.loads(store.get(BlobId(bytes(row["content_sha256"]))))
    assert document["person_labels"] == ["person"]
    assert document["header"]["trust_tier"] == "T2"
    assert document["header"]["epistemic_class"] == "inference"


def test_an_unlocated_person_is_asserted_but_gets_no_occurrence(ingested):
    """A detection with no box has no distinguishing address, so it cannot be an occurrence.

    The claim that somebody is present is still written, as an inference citing the whole
    image. What is not written is a row that would collide with every other boxless person in
    the same photograph under one identity key.
    """
    repository, *_ = ingested
    assert repository.count("occurrence") > 0, "the fixture produced no occurrences at all"
    people = repository.connection.execute(
        "select count(*) as n from occurrence where class = 'person'"
    ).fetchone()
    assert people["n"] == 0

    present = repository.connection.execute(
        "select a.object_value, a.support_span_ids from assertion a "
        "join predicate p on p.predicate_id = a.predicate_id "
        "where p.key = 'person_present' and a.kind = 'inference'"
    ).fetchall()
    assert len(present) == 1
    assert present[0]["object_value"] is None, "person_present carries no object; it is a fact"
    assert len(present[0]["support_span_ids"]) == 1


def test_the_ingest_path_never_writes_an_entity_a_link_or_a_match_proposal(ingested):
    """Invariant 3, which used to be enforced by absence and now has to be enforced by conduct.

    The SQLite mirror carried only the fourteen tables the photograph path needed, so it simply
    had no ``entity`` table and the invariant was structural: there was nowhere for a model's
    guess about who someone is to land. The spine is the whole schema, identity work included,
    so absence is no longer available and the guarantee has to be stated as what it always
    meant. A model's output stops at an occurrence, which is scene-local and carries no name.
    Promotion to an entity, a link or a ranked match proposal is a separate, user-driven act,
    and nothing on this path performs it.
    """
    repository, *_ = ingested
    # Without this the three counts below would be zero on an empty database and the test would
    # pass while proving nothing about the ingest.
    assert repository.count("occurrence") > 0
    assert repository.count("assertion") > 0

    for table in ("entity", "entity_link", "match_proposal"):
        # A fixed literal from the tuple above, never user input.
        written = repository.connection.execute(f"select count(*) as n from {table}").fetchone()
        written = written["n"]
        assert written == 0, f"the ingest wrote {written} {table} row(s)"


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
    tmp_path, photo_dir, repository
):
    from orimera.ingest.exif import UNKNOWN_OFFSET_UNCERTAINTY_MS

    path = write_photo(photo_dir, "nozone.jpg", offset=None)
    store = LocalContentAddressedStore(tmp_path / "blobs")
    PhotoIngestPipeline(repository, store).ingest_file(path)
    anchor = repository.connection.execute("select * from clock_anchor").fetchone()
    assert anchor["uncertainty_ms"] == UNKNOWN_OFFSET_UNCERTAINTY_MS


# -- the ledger -------------------------------------------------------------------------


def _events(repository, run_id):
    return [
        dict(row)
        for row in repository.connection.execute(
            "select * from pipeline_event where run_id = %s order by seq", (run_id,)
        ).fetchall()
    ]


def test_the_ledger_records_every_stage_with_timing_and_its_inputs(ingested):
    repository, _store, _pipeline, _path, outcome = ingested
    events = _events(repository, outcome.run_id)
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1)), "seq must be gapless"

    started = {e["stage_key"]: e for e in events if e["type"] == "stage_started"}
    assert set(started) == {"intake", "rendition", "vision"}
    # input_artifact_ids is recorded, not implied by the shape of the code. It is a uuid[], so
    # an empty list is the value in the column and not a JSON string that happens to render as
    # one.
    assert started["rendition"]["input_artifact_ids"]
    assert started["vision"]["input_artifact_ids"]
    assert started["intake"]["input_artifact_ids"] == []

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
    cost = vision["cost"]
    assert cost["input_tokens"] == 772 and cost["output_tokens"] == 210
    assert vision["model_ref"]["model_id"] == "MiniMaxAI/MiniMax-M3"


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
    header = json.loads(store.get(BlobId(bytes(row["content_sha256"]))))["header"]
    assert header["prompt_version"] == PROMPT_VERSION
    assert header["schema_version"] == SCHEMA_VERSION
    assert header["prompt_sha256"] == prompt_digest()


def test_a_failed_stage_is_recorded_as_failed_with_its_error_class(
    tmp_path, photo_dir, repository
):
    class Exploding:
        model_id = "MiniMaxAI/MiniMax-M3"

        def observe(self, *, image_bytes, media_type):
            raise RuntimeError("the endpoint said no")

    path = write_photo(photo_dir, "a.jpg")
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
    capture = repository.connection.execute("select capture_id from capture").fetchone()
    capture_id = capture["capture_id"]
    repository.connection.execute(
        "update capture set deleted_at = %s where capture_id = %s",
        (dt.datetime(2026, 8, 27, 12, 0, tzinfo=dt.UTC), capture_id),
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


def _ingest_package_modules() -> list[pathlib.Path]:
    """Every Python file in the ingest package, RECURSIVELY.

    Recursively, and that word is the whole of this function. The sweep below used to glob one
    level, which was correct while every stage lived in ``pipeline.py`` and stopped being
    correct the moment the stages moved into ``stages/``. Measured, with an unguarded
    ``put_bytes`` planted in a subpackage of ``orimera/ingest/``: the one-level version reported
    the package clean and passed. That is a coverage check over a set that no longer holds the
    thing being checked, which is the failure mode the route sweep already had once.

    ``test_the_store_write_sweep_can_see_every_stage`` consumes this same walk and asserts it
    reaches the stage modules by name, so the sweep cannot go quiet again by code moving away
    from it.
    """
    package = pathlib.Path(pipeline_module.__file__).parent
    return sorted(package.rglob("*.py"))


def _store_write_call_sites() -> list[str]:
    """Every call to a store write method in the ingest package, as ``path:function``.

    Attributed to the INNERMOST enclosing function, so a write hidden in a closure names the
    closure. A call at module scope is reported as such rather than dropped: import-time is a
    time too, and a write that happens before any guard has run is the worst version of this.
    """
    package = pathlib.Path(pipeline_module.__file__).parent
    sites: list[str] = []
    for path in _ingest_package_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        enclosing: dict[ast.AST, str] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                for inner in ast.walk(node):
                    enclosing[inner] = node.name
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in _STORE_WRITE_METHODS
            ):
                where = enclosing.get(node, "<module scope>")
                sites.append(f"{path.relative_to(package).as_posix()}:{where}")
    return sorted(sites)


def test_the_ingest_package_writes_to_the_object_store_in_exactly_one_place():
    """The ordering guarantee is structural, so it is checked structurally.

    Every payload reaches the store through ``committed_writes``, which flushes only after the
    database transaction has committed and therefore only after the tombstone guard inside that
    transaction has passed. A second write anywhere in the ingest package reopens the hole,
    because the store is not transactional: bytes written before a refusal stay written. This
    is the same kind of source-level guard ``test_models_manifest`` uses to keep model
    identifiers out of Python source, and for the same reason, which is that a rule enforced by
    review is a rule that survives until the reviewer is busy.
    """
    assert _store_write_call_sites() == ["pipeline.py:committed_writes"], (
        "the ingest package writes to the object store outside the post-commit flush: "
        f"{_store_write_call_sites()}. A write that happens before the tombstone guard cannot "
        "be rolled back by the transaction that refuses it."
    )


def test_the_store_write_sweep_can_see_every_stage():
    """The sweep above is a coverage check, so what it covers is asserted rather than assumed.

    A one-level ``glob`` was measured against a planted ``put_bytes`` in a subpackage of
    ``orimera/ingest/``: it reported the package clean and passed, while the recursive walk
    named the offending file and function. The stages then moved into ``stages/``, which is
    exactly where that blind spot was. So this asserts the walk reaches them by name.

    The two tests share ``_ingest_package_modules``. If they did not, this one would be
    asserting that some files exist rather than that the guard reads them, and a coverage check
    over a set nobody verified is the thing this is here to prevent.
    """
    package = pathlib.Path(pipeline_module.__file__).parent
    walked = {path.relative_to(package).as_posix() for path in _ingest_package_modules()}
    required = {
        "pipeline.py",
        "stages/__init__.py",
        "stages/writes.py",
        "stages/intake.py",
        "stages/rendition.py",
        "stages/vision.py",
        "stages/depth.py",
    }
    assert required <= walked, (
        "the store write sweep no longer reads every stage: "
        f"{sorted(required - walked)} were not walked. A write in a file the sweep does not "
        "open is a write the sweep will call clean."
    )


def _commit_a_workspace_tombstone_from_another_connection(ingest_spine) -> None:
    """Commit a tombstone from a second connection, mid-run, exactly as another actor would.

    Workspace scope rather than capture scope, because the capture this run is creating has not
    committed yet and a second connection cannot name a row it cannot see. Workspace scope needs
    no capture_id and fires the same guards, which is what is being tested.
    """
    _repository, open_another = ingest_spine
    other = open_another()
    other.insert_tombstone(scope="workspace", requested_by=uuid.uuid4(), reason="mid-run")


def _race_a_tombstone(
    ingest_spine, tmp_path, photo_dir, monkeypatch, *, intercept: str, on_call: int = 1
):
    """Run one ingest with a real tombstone committed just before ``intercept`` writes.

    Nothing here simulates the guard. The interception commits a real tombstone on a real second
    connection and then calls the real method, so the refusal comes from ``tg_tombstone_guard_*``
    and arrives as an SQLSTATE. That distinction is the point: a trigger can only raise an
    SQLSTATE, an SQLSTATE reaches ``ingest_file`` through its generic handler, and the generic
    handler records the run as **failed**, which is the state a worker retries.
    """
    repository, _open_another = ingest_spine
    path = write_photo(photo_dir, "a.jpg")
    store = LocalContentAddressedStore(tmp_path / "blobs")
    pipeline = PhotoIngestPipeline(repository, store, vision=CountingVisionModel())

    real = getattr(repository, intercept)
    fired = []
    calls = []

    def interception(*args, **kwargs):
        calls.append(True)
        # ``on_call`` exists because a method the pipeline uses in several stages cannot be
        # raced at a chosen stage by intercepting its first call. `find_artifact` is called by
        # intake's own artifact write before intake has committed, so racing there tests the
        # intake guard again rather than the stage after it.
        if len(calls) == on_call and not fired:
            fired.append(True)
            _commit_a_workspace_tombstone_from_another_connection(ingest_spine)
        return real(*args, **kwargs)

    monkeypatch.setattr(repository, intercept, interception)
    outcome = pipeline.ingest_file(path)

    assert fired, f"the interception on {intercept} never ran, so nothing was raced"
    assert outcome.error is not None and "tombstoned" in outcome.error, outcome.error
    assert [e["type"] for e in _events(repository, outcome.run_id)][-1] == "run_cancelled", (
        "a tombstone is terminal. A run recorded as failed is one a worker retries, which is an "
        "unbounded loop against a photograph the user deleted."
    )
    return repository, store


def test_a_tombstone_racing_the_intake_transaction_leaves_the_store_untouched(
    tmp_path, photo_dir, ingest_spine, monkeypatch
):
    """The race the admission check cannot close, and the reason bytes are written last.

    The admission check runs before anything is written. A tombstone committed by another actor
    in the window between that check and the ``evidence_span`` insert is caught by the trigger
    inside the writing transaction instead, and the database rolls back. That rollback is only
    worth something if nothing has been written to the store yet, which is why every payload is
    queued during the transaction and flushed only after it commits.
    """
    repository, store = _race_a_tombstone(
        ingest_spine, tmp_path, photo_dir, monkeypatch, intercept="upsert_span"
    )
    assert repository.count("capture") == 0
    assert repository.count("blob") == 0
    assert list(store.iter_blob_ids()) == [], "the rolled-back transaction left bytes behind"


def test_a_tombstone_racing_the_vision_stage_cancels_the_run_and_writes_no_occurrence(
    tmp_path, photo_dir, ingest_spine, monkeypatch
):
    """The path a real ingest actually takes, and the one the span guard alone does not cover.

    By the time the vision stage runs, intake has committed and its bytes are legitimately in
    the store: they were written before the tombstone existed. What must not happen is the
    vision stage completing, and what must not happen more is the run being recorded as failed,
    because a failed run is retried and the retry would race the same tombstone forever.

    The capture row surviving is honest rather than ideal. A workspace tombstone means delete
    everything, and sweeping what was already committed is the job of the purge worker, which
    does not exist yet: ``purge_job`` is a table with no implementation. What DOES hold since
    migration 0011 is that nothing new is derived from tombstoned bytes; see
    ``test_no_derivative_is_written_for_tombstoned_bytes``.
    """
    repository, _store = _race_a_tombstone(
        ingest_spine, tmp_path, photo_dir, monkeypatch, intercept="insert_occurrence"
    )
    assert repository.count("occurrence") == 0
    assert repository.count("capture") == 1, "intake committed before the tombstone existed"


def test_an_interval_tombstone_covers_the_degenerate_photograph_interval(ingested):
    """Redacting a whole photograph is the degenerate interval redaction [0, 1)."""
    repository, *_ = ingested
    capture = repository.connection.execute("select capture_id from capture").fetchone()
    capture_id = capture["capture_id"]
    blob_row = repository.connection.execute("select blob_sha256 from blob").fetchone()
    from orimera.evidence.blob import BlobId

    blob_id = BlobId(bytes(blob_row["blob_sha256"]))
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

    # The same write as raw SQL, refused by tg_tombstone_guard_span inside the transaction that
    # attempts it. The check above runs before any bytes reach the object store, which is the
    # one thing a trigger cannot do; this one holds on every route into the table, which is the
    # one thing the application check cannot do. The mirror had only the first.
    with (
        pytest.raises(REFUSED, match="tombstoned: write refused for evidence_span"),
        repository.connection.transaction(),
    ):
        repository.connection.execute(
            "insert into evidence_span (workspace_id, blob_sha256, track_key, t_start_ns, "
            "t_end_ns, modality, span_digest) "
            "values (%s, %s, 'img', 0, 1, 'still_image', %s)",
            (repository.workspace_id, blob_id.digest, bytes(range(32))),
        )


def test_a_deterministic_stage_that_changes_its_bytes_emits_an_event_and_keeps_the_old_artifact(
    tmp_path, photo_dir, repository, monkeypatch
):
    """The two hashes exist to make exactly this visible rather than silent.

    ``idempotency_key`` is what the output should be, computed before running.
    ``content_sha256`` is what it turned out to be. When they disagree on a stage that claims
    determinism, the stored artifact wins, because citations and replays already point at it,
    and the disagreement is recorded rather than absorbed.
    """
    from orimera.ingest.stages import rendition as rendition_stage

    path = write_photo(photo_dir, "a.jpg")
    store = LocalContentAddressedStore(tmp_path / "blobs")
    pipeline = PhotoIngestPipeline(repository, store)
    first = pipeline.ingest_file(path)
    original = repository.connection.execute(
        "select artifact_id, content_sha256 from artifact where stage_key = 'rendition'"
    ).fetchone()
    original_hash = bytes(original["content_sha256"])

    # Patched on the rendition stage, which is the module that imports ``render`` and the
    # namespace the call resolves in. Patching it anywhere else leaves the real encoder in
    # place, the bytes match, and this test passes having proved nothing.
    real_render = rendition_stage.render

    def wobble(upright, spec):
        rendition = real_render(upright, spec)
        return dataclasses.replace(rendition, data=rendition.data + b"\x00")

    monkeypatch.setattr(rendition_stage, "render", wobble)
    # Remove the stored bytes so the stage recomputes instead of short circuiting on the store.
    from orimera.evidence.blob import BlobId
    from orimera.store.base import PurgeAuthorization, privileged_purger

    purger = privileged_purger(
        store, PurgeAuthorization(tombstone_id="t", actor="test", reason="force a recompute")
    )
    purger.purge(BlobId(original_hash))

    second = pipeline.ingest_file(path)
    assert second.error is None

    events = _events(repository, second.run_id)
    detected = [e for e in events if e["type"] == "nondeterminism_detected"]
    assert detected, "a deterministic stage produced different bytes and nobody said anything"
    assert original_hash.hex() in detected[0]["error_message"]

    kept = repository.connection.execute(
        "select artifact_id, content_sha256, needs_repair from artifact "
        "where stage_key = 'rendition'"
    ).fetchall()
    assert len(kept) == 1
    assert bytes(kept[0]["content_sha256"]) == original_hash
    # The bytes are gone and this run could not reproduce them, so the row is flagged rather
    # than repointed at bytes the identity key does not name. needs_repair is a real boolean
    # now, not the integer SQLite stored one in.
    assert kept[0]["needs_repair"] is True
    assert first.run_id != second.run_id


def test_no_derivative_is_written_for_tombstoned_bytes(
    tmp_path, photo_dir, ingest_spine, monkeypatch
):
    """R7, closed at the point where it leaked.

    The recorded defect: "Racing a deletion into the window between intake commit and the
    rendition stage leaves three objects committed, including a fresh 768px render of the
    tombstoned photograph." Nine tables carried a tombstone guard and ``artifact`` was not one of
    them, so the next stage wrote a derivative of a photograph the user had just deleted.

    Measured before migration 0011: the rendition row and its bytes were committed. After it, the
    artifact insert is refused inside the writing transaction, and because
    ``committed_writes`` flushes bytes only after that transaction commits, refusing the row
    refuses the bytes with it.

    What this does NOT close is the derivative written BEFORE the tombstone arrived. That is the
    purge queue, and it is still unimplemented.
    """
    # The THIRD call, which is the rendition stage's own look-up: intake's artifact write calls
    # it twice before the intake transaction commits, and racing either of those tests the span
    # guard rather than this one.
    repository, _store = _race_a_tombstone(
        ingest_spine, tmp_path, photo_dir, monkeypatch, intercept="find_artifact", on_call=3
    )
    renditions = repository.connection.execute(
        "select count(*) as n from artifact where stage_key = 'rendition'"
    ).fetchone()["n"]
    assert renditions == 0, "a rendition of tombstoned bytes was written"


def test_the_artifact_guard_refuses_directly_and_not_only_through_the_pipeline(ingest_spine):
    """The guard is a database rule, so it is probed as one.

    A pipeline that stopped calling ``persist_artifact`` would not make this rule stop holding,
    and a test that only drove the pipeline could not tell the difference between the rule and
    the caller's care.
    """
    import uuid as _uuid

    from orimera.evidence.blob import BlobId

    repository, _open_another = ingest_spine
    data = b"bytes that are about to be deleted"
    blob = BlobId.of_bytes(data)
    repository.upsert_blob(blob, byte_size=len(data), media_type="image/jpeg", storage_key="k")
    capture = repository.insert_capture(blob, device_id="probe", started_at=None)
    repository.insert_tombstone(
        scope="capture", capture_id=capture.capture_id, requested_by=_uuid.uuid4()
    )
    repository.connection.execute(
        "update capture set deleted_at = now() where capture_id = %s", (capture.capture_id,)
    )

    with pytest.raises(TombstonedError):
        repository.insert_artifact(
            artifact_id=_uuid.uuid4(),
            kind="rendition",
            source_blob=blob,
            stage_key="rendition",
            stage_version=1,
            params_digest=bytes(32),
            input_digest=bytes(32),
            idempotency_key="probe",
            content_sha256=bytes(32),
            storage_key="k2",
            byte_size=1,
            produced_by_event=None,
        )

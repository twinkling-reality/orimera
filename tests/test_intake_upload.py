"""``POST /intake``, and the property the route exists to keep: the queue holds no bytes.

The tests here are grouped by what they hold, and the grouping matters more than the count.

*   **The eight checks**, one test each, so a refusal that stops saying which check it was
    fails rather than degrades.
*   **The deletion properties.** An evidence address is a content hash of the original bytes,
    and the deletion cascade reaches the rows under the tombstone guards and the objects in the
    content-addressed store. Bytes staged anywhere else are reachable by neither, which is why
    the queue holds a capture id, and there is a test that reads the queue row and asserts that.
*   **Defect 4, which the obvious implementation regresses.** The store write must still land
    after the transaction that ran the tombstone guard commits. A route that wrote the uploaded
    bytes to the store on arrival, which is the natural way to put them somewhere guarded, puts
    purged bytes back on disk when the import is refused.
*   **The two halves joining up.** Intake in the request, derivatives in the worker, and the
    same capture at the end of both.
"""

from __future__ import annotations

import json
import struct
import uuid
import warnings
import zlib

import pytest
from fastapi.testclient import TestClient
from orimera.api.app import create_app
from orimera.api.authorisation import load_token_directory
from orimera.api.body_limit import MAX_BODY_BYTES
from orimera.api.services import Services
from orimera.evidence.blob import BlobId
from orimera.ingest import derivative_queue
from orimera.ingest.decode import MAX_PIXELS
from orimera.ingest.worker import DerivativeWorker
from orimera.store.base import PurgeAuthorization, privileged_purger
from orimera.store.local import LocalContentAddressedStore

from conftest import CountingVisionModel, photo_bytes

_TOKEN = "intake-owner-token-that-is-long-enough-ok"


class Upload:
    """An application over the spine, plus the pieces a test needs to look behind it."""

    def __init__(self, client, store, repository, database, workspace_id, vision) -> None:
        self.client = client
        self.store = store
        self.repository = repository
        self.database = database
        self.workspace_id = workspace_id
        self.vision = vision

    def post(self, parts, *, token: str = _TOKEN):
        return self.client.post(
            "/intake", files=parts, headers={"Authorization": f"Bearer {token}"}
        )

    def one(self, data: bytes | None = None, name: str = "a.jpg", media: str = "image/jpeg"):
        return self.post([("files", (name, photo_bytes() if data is None else data, media))])

    def drain(self):
        """Run the worker to exhaustion, synchronously. No thread, so no waiting and no flake."""
        return DerivativeWorker(
            self.database,
            self.store,
            frozenset({self.workspace_id}),
            vision=self.vision,
            name="test-drain",
        ).drain()

    def rows(self, sql: str, *params):
        return self.repository.connection.execute(sql, params).fetchall()


@pytest.fixture
def upload(tmp_path, repository, spine_schema, monkeypatch):
    _psycopg, scratch = spine_schema
    store = LocalContentAddressedStore(tmp_path / "blobs")
    workspace_id = repository.workspace_id
    monkeypatch.setenv(
        "ORIMERA_API_TOKENS",
        json.dumps(
            {_TOKEN: {"workspace_id": str(workspace_id), "actor": str(uuid.uuid4())}}
        ),
    )
    from tests_support_api import scratch_database

    database = scratch_database(scratch)
    services = Services(
        database=database,
        readonly_database=database,
        store=store,
        tokens=load_token_directory(),
        executor_shares_the_write_role=True,
        model_client=None,
    )
    with TestClient(create_app(services, verify=False)) as client:
        yield Upload(
            client, store, repository, database, workspace_id, CountingVisionModel()
        )


def _bomb_png(width: int, height: int) -> bytes:
    """A PNG whose header declares an enormous frame and whose body is a few bytes.

    Built rather than committed, for the same reason every other test image here is: the
    repository carries no binary fixture and the exact declared size is what is being asserted.
    """

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"\x00" * 16))
        + chunk(b"IEND", b"")
    )


# -- the happy path ------------------------------------------------------------------------


def test_an_upload_returns_202_with_the_capture_and_the_batch_to_watch(upload):
    response = upload.one()
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["refused"] == []
    assert len(body["accepted"]) == 1
    accepted = body["accepted"][0]
    assert accepted["status"] == "ingested"
    assert accepted["filename"] == "a.jpg"

    capture = upload.rows(
        "select capture_id, blob_sha256 from capture where capture_id = %s",
        uuid.UUID(accepted["capture_id"]),
    )
    assert len(capture) == 1
    assert bytes(capture[0]["blob_sha256"]).hex() == accepted["blob_sha256"]
    # The bytes are in the one place a deletion reaches, and they are there before the response.
    assert upload.store.exists(BlobId.from_hex(accepted["blob_sha256"]))
    # And the batch exists to be watched, with the total it actually accepted.
    batch = upload.rows(
        "select declared_size, status from intake_batch where batch_id = %s",
        uuid.UUID(body["batch_id"]),
    )
    assert batch[0]["declared_size"] == 1
    assert batch[0]["status"] == "running", "the worker closes the batch, not the request"


def test_the_same_photograph_twice_is_unchanged_rather_than_a_second_capture(upload):
    data = photo_bytes()
    first = upload.one(data).json()["accepted"][0]
    second = upload.one(data).json()["accepted"][0]
    assert second["status"] == "unchanged"
    assert second["capture_id"] == first["capture_id"]
    assert len(upload.rows("select capture_id from capture")) == 1


def test_two_parts_carrying_one_photograph_queue_that_photograph_once(upload):
    """The response says two files arrived. The queue says one photograph needs work.

    Both are true and they are different questions. Queueing the same capture twice would pay
    for the vision stage twice on a duplicate, which is the normal case in a personal library.
    """
    data = photo_bytes()
    body = upload.post(
        [("files", ("a.jpg", data)), ("files", ("a-copy.jpg", data))]
    ).json()
    assert len(body["accepted"]) == 2
    assert body["accepted"][0]["capture_id"] == body["accepted"][1]["capture_id"]
    payload = upload.rows(
        "select payload from job where job_id = %s", uuid.UUID(body["queued_job_id"])
    )[0]["payload"]
    assert payload["capture_ids"] == [body["accepted"][0]["capture_id"]]
    assert upload.drain()[0].succeeded == 1
    assert upload.vision.calls == 1


def test_the_formation_stream_carries_the_upload_from_received_to_its_outcome(upload):
    """What the person who uploaded actually watches, read after the worker has finished.

    Read after rather than during, deliberately. The stream ends when the batch ends and the
    batch ends when the worker closes it, so reading it while the work is outstanding is a
    subscription that correctly waits: the route's own timeout is thirty minutes. Reading it
    afterwards replays the whole history through the identical code path.
    """
    body = upload.one().json()
    upload.drain()
    response = upload.client.get(
        f"/formation/{body['batch_id']}", headers={"Authorization": f"Bearer {_TOKEN}"}
    )
    assert response.status_code == 200
    phases = [
        json.loads(line[len("data: ") :])["phase"]
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert phases[0] == "received"
    assert "media_extraction" in phases
    assert "entity_indexing" in phases
    assert phases[-1] == "ready", phases


# -- the eight checks, one test each ---------------------------------------------------------


def test_1_an_anonymous_upload_is_refused_before_the_route_runs(upload):
    response = upload.client.post("/intake", files=[("files", ("a.jpg", photo_bytes()))])
    assert response.status_code == 401
    assert upload.rows("select batch_id from intake_batch") == []


def test_2_more_parts_than_one_upload_may_carry_are_refused_by_name(upload):
    from orimera.api.routes.intake import MAX_PARTS

    # One photograph's bytes, many parts. What is being asserted is where the route stops
    # counting, and encoding two hundred distinct JPEGs to assert that would be paying for a
    # different test. That they deduplicate to one capture is the test below.
    data = photo_bytes()
    parts = [("files", (f"{index}.jpg", data)) for index in range(MAX_PARTS + 2)]
    body = upload.post(parts).json()
    reasons = {part["reason"] for part in body["refused"]}
    assert reasons == {"too_many_parts"}
    assert len(body["refused"]) == 2
    assert len(body["accepted"]) == MAX_PARTS


def test_3_a_name_this_pipeline_does_not_read_is_refused_on_its_suffix(upload):
    body = upload.post([("files", ("notes.pdf", photo_bytes(), "application/pdf"))]).json()
    assert body["refused"][0]["reason"] == "unsupported_type"
    assert body["accepted"] == []


def test_4_a_part_larger_than_one_photograph_may_be_is_refused(upload, monkeypatch):
    monkeypatch.setattr("orimera.api.routes.intake.MAX_PART_BYTES", 32)
    body = upload.one().json()
    assert body["refused"][0]["reason"] == "too_large"
    assert upload.rows("select blob_sha256 from blob") == []


def test_5_an_empty_part_is_refused_as_empty_and_not_as_something_else(upload):
    body = upload.post([("files", ("a.jpg", b"", "image/jpeg"))]).json()
    assert body["refused"][0]["reason"] == "empty"


def test_6_bytes_that_are_not_an_image_are_refused_on_the_header(upload):
    body = upload.post([("files", ("a.jpg", b"JFIF is not a JPEG", "image/jpeg"))]).json()
    refused = body["refused"][0]
    assert refused["reason"] == "not_an_image"
    assert upload.rows("select blob_sha256 from blob") == []
    # The detail is written here rather than echoed from Pillow, whose message for this case is
    # "cannot identify image file <_io.BytesIO object at 0x...>": a repr of ours and a heap
    # address, in a response somebody else reads, saying nothing they could act on.
    assert "BytesIO" not in refused["detail"] and "0x" not in refused["detail"], refused


def test_no_refusal_detail_leaks_an_object_repr(upload):
    """One sweep over every refusal this route can produce, rather than one test per message."""
    parts = [
        ("files", ("a.txt", b"x", "text/plain")),
        ("files", ("b.jpg", b"", "image/jpeg")),
        ("files", ("c.jpg", b"JFIF is not a JPEG", "image/jpeg")),
        ("files", ("d.png", _bomb_png(20_000, 20_000), "image/png")),
    ]
    for refused in upload.post(parts).json()["refused"]:
        assert "object at 0x" not in refused["detail"], refused
        assert "<_io." not in refused["detail"], refused


def test_7_a_decompression_bomb_is_refused_and_the_refusal_states_the_pixel_count(upload):
    width, height = 20_000, 20_000
    body = upload.post([("files", ("a.png", _bomb_png(width, height), "image/png"))]).json()
    refused = body["refused"][0]
    assert refused["reason"] == "too_many_pixels"
    assert str(width * height) in refused["detail"], refused["detail"]
    assert upload.rows("select blob_sha256 from blob") == []


def test_7_the_pixel_budget_survives_a_process_that_reset_the_warning_filters(upload):
    """The explicit comparison in ``decode`` is not redundant with the warning filter.

    Pillow only RAISES past twice the limit; between one and two times it, it warns, and the
    promotion of that warning is a process-wide filter anything may reset. A frame in that band
    is the one this asserts, after resetting the filters, because that is the situation a
    library being helpful puts the process in.
    """
    warnings.resetwarnings()
    width, height = 20_000, MAX_PIXELS // 20_000 + 100
    assert MAX_PIXELS < width * height < 2 * MAX_PIXELS
    body = upload.post([("files", ("a.png", _bomb_png(width, height), "image/png"))]).json()
    assert body["refused"][0]["reason"] == "too_many_pixels"


def test_8_bytes_the_user_has_deleted_are_refused_and_no_byte_reaches_the_store(upload):
    """Defect 4, at the upload route. This is the one that the obvious implementation breaks.

    The sequence is the real one: the photograph is uploaded, deleted, its bytes purged, and
    then the same file is uploaded again. What must be true afterwards is that the store is
    empty. It is true only because ``committed_writes`` flushes bytes AFTER the transaction that
    ran the tombstone guard commits; a route that wrote the uploaded bytes to the store on
    arrival, which is the natural way to put them somewhere a tombstone can reach, would leave
    the purged photograph back on disk here.
    """
    data = photo_bytes()
    blob_id = BlobId.of_bytes(data)
    first = upload.one(data).json()["accepted"][0]
    assert upload.store.exists(blob_id)

    tombstone_id = upload.repository.insert_tombstone(
        scope="capture",
        capture_id=uuid.UUID(first["capture_id"]),
        requested_by=uuid.uuid4(),
        reason="the user deleted this photograph",
        blocklist_hash=True,
    )
    upload.repository.connection.execute(
        "update capture set deleted_at = now() where capture_id = %s",
        (uuid.UUID(first["capture_id"]),),
    )
    privileged_purger(
        upload.store,
        PurgeAuthorization(
            tombstone_id=str(tombstone_id), actor="test-operator", reason="the user deleted it"
        ),
    ).purge(blob_id)
    assert not upload.store.exists(blob_id)

    body = upload.one(data).json()
    assert body["refused"][0]["reason"] == "tombstoned"
    assert body["accepted"] == []
    assert not upload.store.exists(blob_id), (
        "the refused re-upload wrote the purged bytes back to the store, which is defect 4"
    )


# -- the bound that has to run before the body is read -----------------------------------------


def test_an_over_large_declared_body_is_refused_before_any_route_sees_it(upload):
    """The only bound that can be applied before a multipart parser writes to disk.

    A route runs after the body has been received and parsed, so the checks inside the route
    bound what reaches the store and the database and cannot bound the temporary file. This one
    is pure ASGI and runs ahead of routing. What it does NOT cover is a request that declares no
    length at all, which is a reverse proxy's to bound; ``docs/deployment.md`` says so.
    """
    declared = MAX_BODY_BYTES + 1
    response = upload.client.post(
        "/intake",
        content=b"x" * 64,
        headers={
            "Authorization": f"Bearer {_TOKEN}",
            "Content-Type": "multipart/form-data; boundary=b",
            "Content-Length": str(declared),
        },
    )
    assert response.status_code == 413, response.text
    assert response.json()["code"] == "body_too_large"
    assert upload.rows("select batch_id from intake_batch") == [], (
        "the request was refused and something still opened a batch for it"
    )


def test_a_body_within_the_bound_reaches_the_route(upload):
    """Otherwise the test above would pass on middleware that refused everything."""
    assert upload.one().status_code == 202


# -- the queue holds no bytes ----------------------------------------------------------------


def test_the_queued_job_holds_capture_ids_and_nothing_that_could_be_a_photograph(upload):
    """The whole of R19's resolution, read straight off the row.

    A payload carrying bytes, a path, a filename or a temporary location would be a staging
    area outside every tombstone guard and outside the purger, and the deletion cascade would
    reach none of it. What is here is a capture id, which names a row the cascade already
    covers, whose bytes are already in the store.
    """
    body = upload.one().json()
    rows = upload.rows(
        "select kind, payload, batch_id, capture_id, state from job where job_id = %s",
        uuid.UUID(body["queued_job_id"]),
    )
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == derivative_queue.DERIVATIVES
    assert row["state"] == "queued"
    assert row["batch_id"] == uuid.UUID(body["batch_id"])
    assert set(row["payload"]) == {"capture_ids"}
    assert row["payload"]["capture_ids"] == [body["accepted"][0]["capture_id"]]


def test_a_batch_can_have_only_one_live_job(upload):
    body = upload.one().json()
    capture_id = uuid.UUID(body["accepted"][0]["capture_id"])
    with pytest.raises(Exception, match="job_one_live_job_per_batch"):
        derivative_queue.enqueue(
            upload.repository.connection,
            upload.workspace_id,
            batch_id=uuid.UUID(body["batch_id"]),
            capture_ids=[capture_id],
        )


def test_queueing_nothing_is_refused_rather_than_written_as_a_job_with_no_work(upload):
    with pytest.raises(ValueError, match="at least one capture"):
        derivative_queue.enqueue(
            upload.repository.connection,
            upload.workspace_id,
            batch_id=uuid.uuid4(),
            capture_ids=[],
        )


def test_an_upload_that_accepts_nothing_queues_nothing_and_closes_its_own_batch(upload):
    """The zero says which zero it is: no job, a declared size of nought, a closed batch."""
    body = upload.post([("files", ("notes.pdf", b"x", "application/pdf"))]).json()
    assert body["queued_job_id"] is None
    assert body["accepted"] == []
    batch = upload.rows(
        "select declared_size, status, ended_at from intake_batch where batch_id = %s",
        uuid.UUID(body["batch_id"]),
    )[0]
    assert batch["declared_size"] == 0
    assert batch["ended_at"] is not None, (
        "nothing will ever close this batch, so its stream would never end"
    )
    assert upload.rows("select job_id from job") == []


# -- the two halves join up -------------------------------------------------------------------


def test_the_request_runs_the_intake_stage_and_nothing_after_it(upload):
    """The property is structural: ``ingest_intake`` runs one stage and cannot run a model.

    Asserted on the artifacts rather than on a model's call count, because a call count can only
    be read off a model the route was given and the route is given none. What this catches is
    the regression that could actually be written: a route that calls ``ingest_file`` and runs
    the whole pipeline, which puts a rendition in a request thread today and a model call in one
    the moment a credential is configured.
    """
    upload.one()
    stages = {row["stage_key"] for row in upload.rows("select stage_key from artifact")}
    assert stages == {"intake"}, stages
    assert upload.vision.calls == 0


def test_the_worker_finishes_the_upload_and_closes_the_batch(upload):
    body = upload.one().json()
    outcomes = upload.drain()
    assert len(outcomes) == 1
    assert outcomes[0].succeeded == 1
    assert outcomes[0].failed == 0

    assert upload.vision.calls == 1
    stages = {
        row["stage_key"]
        for row in upload.rows("select distinct stage_key from artifact")
    }
    assert {"intake", "rendition", "vision"} <= stages
    batch = upload.rows(
        "select status, ended_at from intake_batch where batch_id = %s",
        uuid.UUID(body["batch_id"]),
    )[0]
    assert batch["status"] == "succeeded"
    assert batch["ended_at"] is not None
    assert upload.rows("select state from job")[0]["state"] == "done"


def test_no_run_is_left_saying_it_is_still_running(upload):
    """The ledger is the one thing in this system that is supposed to be true about what happened.

    Two whole-corpus passes run at the end of a job, scene grouping and match proposals, and
    each gets a run of its own. ``run_scene_grouping`` closes a run only when it opened one and
    ``propose_matches`` cannot close anything, because ``Ledger`` lives in a layer the identity
    package may not import. So the caller owns closing them, and before
    :mod:`orimera.ingest.continuity` neither caller did: measured on a real upload against a
    real server, every batch left two ``pipeline_run`` rows in ``running`` for ever. Nothing
    downstream read the column, which is exactly why it stayed wrong.
    """
    upload.one()
    upload.drain()
    still_running = upload.rows("select run_id, trigger from pipeline_run where status = 'running'")
    assert still_running == [], still_running
    assert {row["status"] for row in upload.rows("select status from pipeline_run")} == {
        "succeeded"
    }


def test_the_worker_makes_observations_the_graph_can_be_read_for(upload):
    upload.one()
    upload.drain()
    occurrences = upload.rows("select occurrence_id from occurrence")
    assert occurrences, "the vision stage ran but nothing was recorded from it"


def test_draining_twice_costs_nothing_and_makes_no_second_model_call(upload):
    upload.one()
    upload.drain()
    assert upload.drain() == [], "a drained queue produced a second job"
    assert upload.vision.calls == 1


def test_a_capture_deleted_between_the_two_halves_cancels_rather_than_fails(upload):
    """The ordinary path, not a hole. Migration 0011 refuses the derivative; the run cancels."""
    body = upload.one().json()
    upload.repository.connection.execute(
        "update capture set deleted_at = now() where capture_id = %s",
        (uuid.UUID(body["accepted"][0]["capture_id"]),),
    )
    upload.repository.insert_tombstone(
        scope="capture",
        capture_id=uuid.UUID(body["accepted"][0]["capture_id"]),
        requested_by=uuid.uuid4(),
        reason="deleted while the derivatives were queued",
    )
    outcomes = upload.drain()
    assert outcomes[0].cancelled == 1
    assert outcomes[0].failed == 0
    assert upload.vision.calls == 0, "a model was paid to look at a deleted photograph"
    assert upload.rows("select artifact_id from artifact where stage_key = 'rendition'") == []
    assert upload.rows("select state from job")[0]["state"] == "cancelled"


def test_a_capture_soft_deleted_with_no_tombstone_also_cancels(upload):
    """The branch the tombstone check cannot cover, tested on its own.

    ``capture.deleted_at`` and a ``tombstone`` row are two writes and the schema does not force
    them to happen together, so a capture can be deleted with no tombstone covering its bytes.
    The tombstone check would let that through and the derivative stages would run over a
    photograph the user removed. The check on the row itself is what stops it, and this is why
    ``IngestRepository.capture`` deliberately does not filter on ``deleted_at``: filtering there
    turns a deletion into a lookup miss, which is recorded as failed and retried.
    """
    body = upload.one().json()
    upload.repository.connection.execute(
        "update capture set deleted_at = now() where capture_id = %s",
        (uuid.UUID(body["accepted"][0]["capture_id"]),),
    )
    assert upload.rows("select tombstone_id from tombstone") == []
    outcomes = upload.drain()
    assert outcomes[0].cancelled == 1
    assert outcomes[0].failed == 0
    assert upload.rows("select artifact_id from artifact where stage_key = 'rendition'") == []


def test_the_worker_never_touches_another_workspace(upload):
    body = upload.one().json()
    stranger = DerivativeWorker(
        upload.database,
        upload.store,
        frozenset({uuid.uuid4()}),
        vision=upload.vision,
        name="stranger",
    )
    assert stranger.drain() == []
    assert upload.rows("select state from job")[0]["state"] == "queued"
    assert body["queued_job_id"] is not None

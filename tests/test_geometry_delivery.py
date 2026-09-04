"""The delivery route: the first production path by which a derivative reaches a renderer.

ADR-0009 D10. Until this existed, "no route serves artifact bytes, and the only loader in the
workspace is a development preview, while the app's own comment claiming that production reads
point maps from an API describes an implementation that does not exist". Every test here is about
one of the three clauses that record puts on the route: **bytes in hand, a bearer in the header,
and the content hash verified against the descriptor that named it.**

The authorisation half is not repeated here. ``tests/test_api.py`` sweeps every route in the
application, generated from the router, and both geometry routes are in it: an anonymous caller
gets 401, an unknown token gets 401, a stranger never gets a 403, and a stranger probing a real
artifact id gets the same bytes-for-bytes response as one probing an invented one. What is here
is what that sweep cannot see: what the owner gets, and what happens to it when the owner deletes
something.

**Two tests in this file pin a gap rather than a guarantee**, and they say so in their own
docstrings. A test that asserts today's wrong answer is a liability unless it names what would
make it right, so each one names the record the gap is written down in and fails the day the gap
is closed, which is the moment somebody should be reading it.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid

import pytest
from exulanica.api.app import create_app
from exulanica.api.authorisation import load_token_directory
from exulanica.api.routes.geometry import POINT_MAP_MEDIA_TYPE
from exulanica.api.services import Services
from exulanica.evidence.blob import BlobId
from exulanica.graph.geometry import POINT_MAP_KIND
from exulanica.ingest.pipeline import PhotoIngestPipeline
from exulanica.ingest.stages import stage
from exulanica.store.local import LocalContentAddressedStore
from fastapi.testclient import TestClient

from conftest import CountingVisionModel, iso, write_photo, write_point_map

_TOKEN = "geometry-owner-token-that-is-long-enough"
_STRANGER = "geometry-stranger-token-that-is-long-enough"

#: Distinct bytes per photograph, so a test that fetched the wrong artifact says so rather than
#: passing because two payloads happened to be equal.
_FIRST = b"point map for the first photograph"
_SECOND = b"point map for the second photograph"


class Delivered:
    """A workspace with two photographs, a point map for each, and an app in front of them."""

    def __init__(self, client, repository, store, first, second) -> None:
        self.client = client
        self.repository = repository
        self.store = store
        self.first = first
        self.second = second

    def get(self, path: str, token: str = _TOKEN, headers: dict[str, str] | None = None):
        return self.client.get(
            path, headers={"Authorization": f"Bearer {token}", **(headers or {})}
        )

    def descriptors(self, token: str = _TOKEN) -> list[dict]:
        response = self.get("/geometry", token)
        assert response.status_code == 200, response.text
        return response.json()

    def sql(self, statement: str, *params):
        return self.repository.connection.execute(statement, params).fetchall()


@pytest.fixture
def delivered(tmp_path, photo_dir, repository, spine_schema, monkeypatch):
    """Two ingested photographs, each with a hand-written point map, behind a real application.

    The point maps are written by hand rather than by running the depth stage. The stage needs
    torch and a 1.3 GB checkpoint and is an optional extra that CI does not install, and what is
    under test here is the route rather than the model:
    :func:`conftest.write_point_map` computes the identity key with the real stage registry, so
    the rows it writes are the rows the stage would write.
    """
    _psycopg, scratch = spine_schema
    store = LocalContentAddressedStore(tmp_path / "blobs")
    pipeline = PhotoIngestPipeline(repository, store, vision=CountingVisionModel())

    written = []
    for name, when, payload in (
        ("second.jpg", iso(14), _SECOND),
        ("first.jpg", iso(9), _FIRST),
    ):
        # Ingested newest first, so a route that returned rows in insertion order rather than in
        # the documented presentation order would pass the ordering test by accident.
        outcome = pipeline.ingest_file(write_photo(photo_dir, name, when=when))
        assert outcome.error is None, outcome.error
        blob = BlobId.of_bytes((photo_dir / name).read_bytes())
        artifact_id, _ = write_point_map(repository, store, blob, payload)
        written.append((artifact_id, blob, payload))

    monkeypatch.setenv(
        "EXULANICA_API_TOKENS",
        json.dumps(
            {
                _TOKEN: {
                    "workspace_id": str(repository.workspace_id),
                    "actor": str(uuid.uuid4()),
                },
                _STRANGER: {"workspace_id": str(uuid.uuid4()), "actor": str(uuid.uuid4())},
            }
        ),
    )
    from tests_support_api import scratch_database

    database = scratch_database(scratch)
    app = create_app(
        Services(
            database=database,
            readonly_database=database,
            store=store,
            tokens=load_token_directory(),
            executor_shares_the_write_role=True,
            model_client=None,
        ),
        verify=False,
    )
    with TestClient(app) as client:
        # `written` is in ingest order, which is second then first. The names below are the
        # photographs' own order in time, which is what the route is documented to return.
        yield Delivered(client, repository, store, first=written[1], second=written[0])


# -- what the route is for ------------------------------------------------------------------


def test_the_kind_the_route_serves_is_the_kind_the_depth_stage_writes():
    """The one string that spans two packages the layering forbids from importing each other.

    ``exulanica.graph`` and ``exulanica.ingest`` are siblings in the import contract, so the
    artifact kind is spelled twice. A rename that reached only the stage would
    leave the route serving an empty list for ever, with nothing failing
    anywhere, which is exactly the shape of defect this
    repository's register keeps recording: a test that passes without exercising its case.
    """
    assert stage("depth").output_kind == POINT_MAP_KIND


def test_the_descriptor_names_the_digest_the_bytes_actually_hash_to(delivered):
    """D10's third clause, end to end. This is the whole point of there being two routes."""
    descriptors = delivered.descriptors()
    assert len(descriptors) == 2
    for descriptor in descriptors:
        reference = descriptor["reference"]
        assert reference["authorization"] == "workspace-bearer"
        assert reference["href"] == f"/geometry/{descriptor['artifact_id']}"
        response = delivered.get(reference["href"])
        assert response.status_code == 200, response.text
        assert hashlib.sha256(response.content).hexdigest() == reference["content_sha256"]
        assert len(response.content) == reference["byte_size"]


def test_the_bytes_arrive_as_a_container_and_never_as_an_image(delivered):
    """A point map is not evidence and is not a picture. Nothing may sniff it into one."""
    href = delivered.descriptors()[0]["reference"]["href"]
    response = delivered.get(href)
    assert response.headers["content-type"] == POINT_MAP_MEDIA_TYPE
    assert response.headers["x-content-type-options"] == "nosniff"
    # Somebody's photograph, one derivation removed, and the user holds no second copy of it. A
    # cache holding it is a copy of the corpus the deletion path cannot reach, and the browser's
    # own on-disk cache is as much of one as a shared proxy. `private` alone would leave a
    # deleted region's geometry redrawable from disk for an hour after the tombstone committed.
    assert response.headers["cache-control"] == "no-store"


def test_the_etag_is_the_content_hash_and_is_not_the_check(delivered):
    """It is a strong validator, because a content-addressed store has nothing weaker to offer.

    A client that verified the body against this header would be checking the response against
    itself. The descriptor is what named the digest before the transfer began, and
    ``web/packages/app/src/geometry-api.ts`` verifies against that.
    """
    descriptor = delivered.descriptors()[0]
    response = delivered.get(descriptor["reference"]["href"])
    assert response.headers["etag"] == f'"{descriptor["reference"]["content_sha256"]}"'


def test_a_range_request_gets_the_whole_file_rather_than_a_fragment(delivered):
    """The one byte route in this API that offers no ranges, and it says so in a header.

    The evidence route offers them, because a citation deep link should not have to transfer a
    whole photograph to show the top of it. Here a fragment is exactly the thing a client cannot
    check against a digest of the whole, so the response is the whole file and ``Accept-Ranges``
    says ``none`` rather than leaving a client to infer it from a missing header.
    """
    descriptor = delivered.descriptors()[0]
    response = delivered.get(descriptor["reference"]["href"], headers={"Range": "bytes=0-3"})
    assert response.status_code == 200
    assert response.headers["accept-ranges"] == "none"
    assert len(response.content) == descriptor["reference"]["byte_size"]


def test_the_list_is_keyed_by_capture_and_ships_no_island(delivered):
    """ADR-0005 leaves what an island is to the client, and this route does not settle it.

    ``exulanica.graph``'s own docstring: "A server that shipped an island id would be settling that
    question by accident." The client maps captures to islands through the same function its
    occurrences went through, so geometry lands in the regions the anchors did.
    """
    descriptors = delivered.descriptors()
    live = {str(row["capture_id"]) for row in delivered.sql("select capture_id from capture")}
    assert {row["capture_id"] for row in descriptors} == live
    for row in descriptors:
        assert not any("island" in key or "region" in key for key in row)
        # And no rung: the recorded claim already reaches the client on the graph payload, and a
        # second copy on the wire is the divergence ADR-0009 D11 complains about.
        assert "rung" not in row


def test_the_order_is_the_first_photograph_of_the_visit_first(delivered):
    """A region holds several point maps and the renderer takes one, so something has to choose.

    The choice is made once, here, so that two clients cannot make it differently. The order is
    ``capture.started_at`` and then ``capture_id``; the fixture ingests the later photograph
    first so that insertion order and the documented order disagree.
    """
    descriptors = delivered.descriptors()
    assert [row["artifact_id"] for row in descriptors] == [
        str(delivered.first[0]),
        str(delivered.second[0]),
    ]


def test_a_descriptor_says_which_container_the_bytes_were_written_under(delivered):
    """Read from the stage definition carrying the row's own params digest, not from the registry.

    ADR-0010 gives ``.opm`` a version 2 whose validators "refuse version 1 by name". A client
    that can read one container and not the other has to know before it spends three megabytes,
    and the answer has to be what this artifact was written under rather than what the stage
    would write today.
    """
    for descriptor in delivered.descriptors():
        assert descriptor["container"] == stage("depth").params["container"]


# -- what happens when the user deletes something --------------------------------------------


def test_a_deleted_capture_makes_its_geometry_gone_rather_than_missing(delivered):
    """410, not 404, and the distinction is one the user is entitled to.

    It also happens **before the purger has run**: a tombstone is authoritative from the moment
    it commits and the bytes catch up later, so a route that consulted ``artifact.purged_at``
    alone would keep serving a deleted photograph's geometry for as long as the queue took.
    """
    capture = delivered.sql(
        "select capture_id from capture where blob_sha256 = %s", delivered.first[1].digest
    )[0]["capture_id"]
    href = f"/geometry/{delivered.first[0]}"
    assert delivered.get(href).status_code == 200

    delivered.repository.insert_tombstone(
        scope="capture", requested_by=uuid.uuid4(), capture_id=capture, reason="the user asked"
    )
    assert delivered.sql("select purged_at from artifact where content_sha256 is not null")
    gone = delivered.get(href)
    assert gone.status_code == 410, gone.text
    assert gone.json()["code"] == "tombstoned"
    assert [row["artifact_id"] for row in delivered.descriptors()] == [str(delivered.second[0])]


def test_an_interval_redaction_over_the_whole_frame_withdraws_the_geometry_too(delivered):
    """The capture is still live, and the geometry is still gone.

    This is why the read asks ``tombstone_blocks_capture`` rather than testing ``deleted_at``.
    An interval tombstone soft-marks nothing: migration 0015's trigger returns early for any
    scope but ``capture`` and ``workspace``. A route that keyed on the capture being deleted
    would serve the redacted frame's geometry back, which is the whole of what a still image's
    interval covers.
    """
    capture = delivered.sql(
        "select capture_id from capture where blob_sha256 = %s", delivered.first[1].digest
    )[0]["capture_id"]
    tombstone = delivered.repository.insert_tombstone(
        scope="interval",
        requested_by=uuid.uuid4(),
        capture_id=capture,
        track_key="img",
        interval_ns=[(0, 1)],
        reason="redacted",
    )
    live = delivered.sql(
        "select deleted_at from capture where capture_id = %s", capture
    )[0]["deleted_at"]
    assert live is None, "an interval tombstone does not soft-mark the capture, and should not"
    assert delivered.get(f"/geometry/{delivered.first[0]}").status_code == 410
    assert [row["artifact_id"] for row in delivered.descriptors()] == [str(delivered.second[0])]

    # The other half of the same paragraph in domain-and-evidence-model.md 6.4, and it is the
    # half that is a gap: nothing is enqueued, nothing is soft-marked, and the artifact the
    # cascade table says would be marked `needs_repair` is not marked. The bytes are withheld
    # and they are still on the disk.
    assert not delivered.sql(
        "select purge_id from purge_job where tombstone_id = %s", tombstone
    ), "an interval tombstone now enqueues work; rewrite the CORRECTED note in section 6.4"
    assert delivered.sql(
        "select needs_repair from artifact where artifact_id = %s", delivered.first[0]
    )[0]["needs_repair"] is False


def test_a_purged_artifact_is_gone_rather_than_absent(delivered):
    """The other half of the same fact, from the far side of the queue."""
    delivered.repository.connection.execute(
        "update artifact set purged_at = now(), storage_key = null where artifact_id = %s",
        (delivered.first[0],),
    )
    assert delivered.get(f"/geometry/{delivered.first[0]}").status_code == 410


def test_an_artifact_whose_object_vanished_is_reported_rather_than_served(delivered):
    """A row that survived its bytes is a third state, and it is not "no geometry here".

    The list says ``bytes_missing`` and offers no reference, because a reference to bytes that
    are not there is an invitation to fetch them. The byte route answers **424** with the same
    ``unavailable_asset`` code ``/world/source-media`` uses for the same fact, and does **not**
    borrow the application's ``BlobNotFoundError`` handler, whose message is "no such evidence":
    a point map is not evidence, and saying it is in a message would undo, in prose, the
    separation invariant 2 keeps in the schema. 424 rather than 404 is safe because only a caller
    whose own workspace holds the row can reach it; a stranger's read found nothing and stopped.
    """
    path = delivered.store.root / delivered.store.key_for(
        BlobId.from_hex(delivered.descriptors()[0]["reference"]["content_sha256"])
    )
    os.chmod(path, 0o644)
    path.unlink()

    descriptor = next(
        row for row in delivered.descriptors() if row["artifact_id"] == str(delivered.first[0])
    )
    assert descriptor["state"] == "bytes_missing"
    assert descriptor["reference"] is None
    assert descriptor["reason"] is not None

    response = delivered.get(f"/geometry/{delivered.first[0]}")
    assert response.status_code == 424
    assert response.json()["code"] == "unavailable_asset"
    assert "evidence" not in response.text


def test_bytes_that_no_longer_hash_to_their_key_are_refused_loudly(delivered):
    """500, never a 404 and never the bytes. The store re-hashes and this route lets it.

    ``app.py`` on ``IntegrityError``: "Stored bytes that do not hash to the key they are stored
    under means a citation has stopped verifying, and serving anything at all here would hide
    it." A derivative is not a citation, and the reasoning survives the difference: the digest in
    the descriptor is what a client checks against, so bytes that stopped matching their key are
    bytes no client could accept and no server should hand over.
    """
    path = delivered.store.root / delivered.store.key_for(
        BlobId.from_hex(delivered.descriptors()[0]["reference"]["content_sha256"])
    )
    os.chmod(path, 0o644)
    path.write_bytes(b"substituted, same length as nothing in particular")

    response = delivered.get(f"/geometry/{delivered.first[0]}")
    assert response.status_code == 500
    assert response.json()["code"] == "integrity_failure"


# -- the gaps this work found, pinned so that closing one is visible -------------------------


def test_a_person_scoped_withdrawal_reaches_no_derivative(delivered):
    """PINS A GAP. ADR-0009's note, made executable, in the two places it is actually visible.

    ``domain-and-evidence-model.md`` section 6.4 specifies an entity cascade: deleting a person
    soft-marks "entity, links, proposals, entity-level aggregates" and physically purges
    "entity-level embeddings and exemplars, display name". None of that happens, and this asserts
    the two facts that make it so:

    *   **The product cannot express the request.** ``IngestRepository.insert_tombstone`` takes no
        ``entity_id``, and ``tombstone`` constrains ``scope = 'entity'`` to name one, so no code
        path in this repository can write an entity-scope tombstone at all.
    *   **Written directly, it enqueues nothing.** Migration 0015's trigger returns early for any
        scope but ``capture`` and ``workspace``, so no purge job exists and nothing is destroyed.

    This is correct for the photograph and for its geometry: "Entity deletion is not media
    deletion", which section 6.4 lists among the consequences that "must not be softened". It is
    not correct for the entity-level derivatives that section promises to destroy. The gap is
    recorded in that section under CORRECTED. **When it is closed, this test fails**, which is the
    right moment for somebody to be reading it.
    """
    import inspect

    from exulanica.ingest.repository import IngestRepository

    signature = inspect.signature(IngestRepository.insert_tombstone)
    assert "entity_id" not in signature.parameters, (
        "insert_tombstone can now express an entity scope. Check that the purge cascade reaches "
        "the entity-level derivatives domain-and-evidence-model.md 6.4 promises, and rewrite "
        "this test and that section's CORRECTED note together."
    )

    entity = delivered.sql("select entity_id from entity limit 1")
    tombstone = delivered.repository.connection.execute(
        "insert into tombstone (workspace_id, scope, entity_id, requested_by, reason) "
        "values (%s, 'entity', %s, %s, 'the person withdrew') returning tombstone_id",
        (
            delivered.repository.workspace_id,
            entity[0]["entity_id"] if entity else uuid.uuid4(),
            uuid.uuid4(),
        ),
    ).fetchone()["tombstone_id"]

    assert not delivered.sql(
        "select purge_id from purge_job where tombstone_id = %s", tombstone
    ), "an entity tombstone now enqueues work; see this test's docstring"
    # And the photograph, and its geometry, are still there. That part is by design.
    assert delivered.get(f"/geometry/{delivered.first[0]}").status_code == 200


def test_a_pose_job_directory_is_not_an_artifact_and_no_tombstone_reaches_it(tmp_path):
    """PINS A GAP. ADR-0009 D12, and one detail of it that the record does not yet carry.

    A COLMAP job writes ``database.db``, holding SIFT descriptors of every image it was given,
    into a directory keyed by the manifest digest and known to nothing else in the system.
    Nothing registers it as an artifact, so no tombstone reaches it, and D12 says so.

    What D12 also says is "the job directory is deleted when the receipt is accepted", and that
    is not implementable as written: ``receipt.json`` and ``manifest.json`` live **inside** the
    job directory and are what makes a completed job return without invoking COLMAP again.
    Deleting the directory would destroy the reuse path along with the descriptors. The
    separation this asserts is the one a fix has to keep: the working database is not the
    receipt, and only one of the two is a derivative of a photograph.
    """
    import inspect

    from exulanica.reconstruction import pose

    source = inspect.getsource(pose)
    assert 'job_dir / "database.db"' in source, (
        "the working SIFT database has moved. Whatever holds it now is still a derivative of "
        "photographs outside the deletion cascade until something registers it as an artifact."
    )
    assert 'job_dir / "receipt.json"' in source, (
        "the receipt no longer lives in the job directory. D12's 'the job directory is deleted "
        "when the receipt is accepted' may now be implementable as written; check whether it is, "
        "and update ADR-0009 D12 with what was done."
    )

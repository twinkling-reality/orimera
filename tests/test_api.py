"""The HTTP surface, including the authorisation sweep that is generated from the router.

``evaluation-methodology.md`` M10 specifies how the authorisation half is tested, and the shape
of the requirement is unusual enough to quote:

    "**DECISION: table-driven, generated from the router, so a new route without a test fails
    CI.** User U1 owns the corpus; U2 owns nothing. For every read path, assert U2 receives a
    not-found response: API routes, citation deep links, share links, graph API, query API, and
    direct object storage URLs. **404, never 403**, so the surface is not an existence oracle.
    Nonexistent and foreign IDs return the identical code."

So the sweep below does not enumerate routes by hand. It walks ``app.routes``, and a route that
is neither exercised nor explicitly listed as public fails the test. Adding an endpoint without
thinking about who may call it is not possible here; the suite goes red.
"""

from __future__ import annotations

import copy
import json
import uuid

import pytest
from fastapi.testclient import TestClient
from orimera.api.app import create_app
from orimera.api.authorisation import load_token_directory
from orimera.api.services import Services
from orimera.epistemics.assertions import AssertionWriter
from orimera.identity import IdentityRepository, name_occurrence
from orimera.ingest.batch import IntakeBatch
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.store.local import LocalContentAddressedStore

from conftest import DEFAULT_PAYLOAD, CountingVisionModel, write_photo

#: Routes that are deliberately unauthenticated, with the reason each one is.
PUBLIC_ROUTES: dict[str, str] = {
    "/healthz": "a liveness probe that needed a credential would go red when it rotated",
    "/readyz": "the same, and it reports no workspace content",
    "/openapi.json": "the schema of the API, which is not data",
    "/docs": "the schema of the API, which is not data",
    "/docs/oauth2-redirect": "part of the docs page",
    "/redoc": "the schema of the API, which is not data",
}

#: A request body for every authenticated route, so the sweep can actually call it. A route
#: missing from here and from PUBLIC_ROUTES fails `test_every_route_is_covered_by_this_file`.
ROUTE_PROBES: dict[tuple[str, str], dict] = {
    ("GET", "/graph"): {},
    ("GET", "/selection/catalogue"): {},
    ("POST", "/selection"): {"json": {"intent": "captures"}},
    ("POST", "/selection/packet"): {"json": {"intent": "captures"}},
    ("POST", "/selection/plan"): {"json": {"question": "where was I?"}},
    ("POST", "/selection/ask"): {"json": {"question": "where was I?"}},
    ("GET", "/evidence"): {"params": {"uri": "orimera://blob/x/img#t=0,1"}},
    ("GET", "/evidence/{span_id}"): {},
    ("GET", "/evidence/{span_id}/region"): {},
    ("GET", "/identity/events"): {},
    # The stream is opened but never read here: an anonymous or foreign caller is refused
    # before the generator starts, which is the only thing this sweep asks about. Reading it
    # as the owner is `test_formation_stream.py`, which has a batch to read.
    ("GET", "/formation"): {},
    ("GET", "/formation/{batch_id}"): {},
    ("POST", "/identity/name"): {
        "json": {"occurrence_id": str(uuid.uuid4()), "display_name": "X"}
    },
    ("POST", "/identity/confirm"): {
        "json": {"occurrence_id": str(uuid.uuid4()), "entity_id": str(uuid.uuid4())}
    },
    ("POST", "/identity/reject"): {
        "json": {"occurrence_id": str(uuid.uuid4()), "entity_id": str(uuid.uuid4())}
    },
    ("POST", "/identity/revoke"): {"json": {"occurrence_id": str(uuid.uuid4())}},
    ("POST", "/identity/merge"): {
        "json": {"sources": [str(uuid.uuid4())], "target": str(uuid.uuid4())}
    },
    ("POST", "/identity/split"): {
        "json": {"entity_id": str(uuid.uuid4()), "occurrence_ids": [str(uuid.uuid4())]}
    },
    ("POST", "/identity/undo"): {"json": {"event_id": str(uuid.uuid4())}},
}

_OWNER_TOKEN = "owner-token-that-is-long-enough-to-be-accepted"
_STRANGER_TOKEN = "stranger-token-that-is-long-enough-to-pass"


class Deployment:
    """An application over the test schema, with two tokens: one owner and one stranger."""

    def __init__(
        self, client, store, owner, stranger, span_id, occurrence_id, entity_id, batch_id
    ) -> None:
        self.client = client
        self.store = store
        self.owner = owner
        self.stranger = stranger
        self.span_id = span_id
        self.occurrence_id = occurrence_id
        self.entity_id = entity_id
        self.batch_id = batch_id

    def _request(self, token: str, method: str, path: str, **kwargs):
        headers = {"Authorization": f"Bearer {token}", **kwargs.pop("headers", {})}
        return self.client.request(method, path, headers=headers, **kwargs)

    def as_owner(self, method: str, path: str, **kwargs):
        return self._request(_OWNER_TOKEN, method, path, **kwargs)

    def as_stranger(self, method: str, path: str, **kwargs):
        return self._request(_STRANGER_TOKEN, method, path, **kwargs)

    def fill(self, path: str) -> str:
        return path.replace("{span_id}", str(self.span_id)).replace(
            "{batch_id}", str(self.batch_id)
        )


@pytest.fixture
def deployment(tmp_path, photo_dir, repository, spine_schema, monkeypatch):
    """One ingested photograph, one named person, and an app wired to that schema.

    The stranger's token names a workspace that exists as a uuid and owns nothing, which is the
    U2 of M10. It is a real session rather than an invalid credential, because the question
    being asked is what an authenticated caller sees of somebody else's library.
    """
    _psycopg, scratch = spine_schema
    store = LocalContentAddressedStore(tmp_path / "blobs")
    payload = copy.deepcopy(DEFAULT_PAYLOAD)
    payload["objects"] = [
        {
            "label": "person",
            "salience": "primary",
            "confidence": "high",
            "box": {"x": 0.5, "y": 0.1, "w": 0.2, "h": 0.6},
        }
    ]
    pipeline = PhotoIngestPipeline(repository, store, vision=CountingVisionModel(payload=payload))
    outcome = pipeline.ingest_file(write_photo(photo_dir, "a.jpg"))
    assert outcome.error is None, outcome.error

    owner = repository.workspace_id
    actor = uuid.uuid4()
    occurrence = repository.connection.execute(
        "select occurrence_id from occurrence where class = 'person' limit 1"
    ).fetchone()
    named = name_occurrence(
        IdentityRepository(repository.connection, owner),
        AssertionWriter(repository.connection, owner),
        occurrence_id=occurrence["occurrence_id"],
        display_name="Julie",
        actor=actor,
    )
    span = repository.connection.execute(
        "select span_id from evidence_span where modality = 'still_image' limit 1"
    ).fetchone()

    # A real batch, so the formation route has something to be asked about. Opened and closed
    # immediately: an open batch would make the stream wait for events that are never coming.
    batch = IntakeBatch.open(repository, label="test")
    batch.declare_size(1)
    batch.close("succeeded")

    stranger = uuid.uuid4()
    monkeypatch.setenv(
        "ORIMERA_API_TOKENS",
        json.dumps(
            {
                _OWNER_TOKEN: {"workspace_id": str(owner), "actor": str(actor)},
                _STRANGER_TOKEN: {"workspace_id": str(stranger), "actor": str(uuid.uuid4())},
            }
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
    app = create_app(services, verify=False)
    with TestClient(app) as client:
        yield Deployment(
            client, store, owner, stranger, span["span_id"], occurrence["occurrence_id"],
            named.entity_id, batch.batch_id,
        )


# -- the sweep ----------------------------------------------------------------------------


def _routes(app) -> list[tuple[str, str]]:
    """Every routable (method, path) in the application, however the framework nests them.

    THIS WALKS A TREE AND IT DID NOT USED TO. FastAPI 0.141 stopped flattening an included
    router's routes into ``app.routes`` and started storing an ``_IncludedRouter`` wrapper there
    instead. The previous version of this function iterated ``app.routes`` one level deep and
    read ``.methods`` off each entry, so from that release onward it saw the four documentation
    routes and six wrappers with no ``methods`` attribute, and returned only the documentation
    routes. Every one of those is in ``PUBLIC_ROUTES``, so the coverage check below computed an
    empty list of uncovered routes and passed, on an application whose entire authenticated
    surface it could no longer see.

    That is the failure this file's own docstring says it exists to prevent, and it is the
    failure mode `.orimera/working/known-defects.md` records twice: a test that passes without
    exercising its case. It was found by adding a route and noticing the suite stayed green.

    So the walk is recursive over anything that carries routes, and
    ``test_the_route_sweep_can_actually_see_the_application`` below asserts the walk found the
    surface rather than trusting that it did.
    """
    found: list[tuple[str, str]] = []
    seen: set[int] = set()
    stack = [app]
    while stack:
        node = stack.pop()
        if id(node) in seen:
            continue
        seen.add(id(node))
        for attribute in ("routes", "original_router"):
            nested = getattr(node, attribute, None)
            if nested is None:
                continue
            stack.extend(nested if isinstance(nested, list) else [nested])
        path = getattr(node, "path", None)
        if path is None:
            continue
        for method in sorted(getattr(node, "methods", set()) - {"HEAD", "OPTIONS"}):
            found.append((method, path))
    return sorted(set(found))


def test_the_route_sweep_can_actually_see_the_application(deployment):
    """The guard on the guard, and it is not decoration.

    A coverage check over an empty set of routes passes. So before asking whether every route is
    covered, this asks whether the walk found any routes at all, and whether it found ones this
    file knows exist by name. Both halves matter: a walk that returned nothing and a walk that
    returned only the documentation pages are both green under the check below, and both mean the
    authorisation sweep is testing nothing.
    """
    found = _routes(deployment.client.app)
    assert ("GET", "/graph") in found, found
    assert ("POST", "/identity/name") in found, found
    assert ("GET", "/evidence/{span_id}") in found, found
    # Every probed route must be reachable. A probe for a route that no longer exists is a test
    # asserting things about nothing, which is the same defect pointing the other way.
    missing = sorted(set(ROUTE_PROBES) - set(found))
    assert not missing, f"probed routes that the application does not serve: {missing}"


def test_every_route_is_covered_by_this_file(deployment):
    """The generated half. A new endpoint with no entry here fails, which is the point."""
    uncovered = [
        (method, path)
        for method, path in _routes(deployment.client.app)
        if path not in PUBLIC_ROUTES and (method, path) not in ROUTE_PROBES
    ]
    assert not uncovered, (
        f"these routes are neither public nor probed: {uncovered}. Add them to ROUTE_PROBES "
        "with a body, or to PUBLIC_ROUTES with the reason they need no credential."
    )


@pytest.mark.parametrize(("method", "path"), sorted(ROUTE_PROBES))
def test_every_authenticated_route_refuses_an_anonymous_caller(deployment, method, path):
    response = deployment.client.request(
        method, deployment.fill(path), **ROUTE_PROBES[(method, path)]
    )
    assert response.status_code == 401, response.text
    assert response.json()["code"] == "unauthenticated"


@pytest.mark.parametrize(("method", "path"), sorted(ROUTE_PROBES))
def test_every_authenticated_route_refuses_a_bad_token(deployment, method, path):
    response = deployment.client.request(
        method,
        deployment.fill(path),
        headers={"Authorization": "Bearer not-a-configured-token-but-long-enough"},
        **ROUTE_PROBES[(method, path)],
    )
    assert response.status_code == 401, response.text


@pytest.mark.parametrize(("method", "path"), sorted(ROUTE_PROBES))
def test_a_stranger_never_gets_a_403(deployment, method, path):
    """M10: "404, never 403, so the surface is not an existence oracle."

    A 403 on somebody else's id confirms that the id exists and belongs to someone. Every route
    that can be reached with another workspace's id must answer as though it were not there.
    """
    response = deployment.as_stranger(
        method, deployment.fill(path), **ROUTE_PROBES[(method, path)]
    )
    assert response.status_code != 403, (
        f"{method} {path} returned 403 to a stranger, which confirms the resource exists"
    )


@pytest.mark.parametrize(
    "path", ["/evidence/{span_id}", "/evidence/{span_id}/region"]
)
def test_a_stranger_gets_the_same_answer_for_a_real_id_and_an_invented_one(deployment, path):
    """The IDOR case, explicitly: U1's span id substituted into U2's session."""
    real = deployment.as_stranger("GET", deployment.fill(path))
    invented = deployment.as_stranger("GET", path.replace("{span_id}", str(uuid.uuid4())))
    assert real.status_code == 404
    assert real.status_code == invented.status_code
    assert real.json() == invented.json()


def test_the_owner_can_read_what_the_stranger_cannot(deployment):
    """Otherwise every test above would pass on an application that refused everybody."""
    for path in ("/evidence/{span_id}", "/evidence/{span_id}/region"):
        assert deployment.as_owner("GET", deployment.fill(path)).status_code == 200


# -- health -------------------------------------------------------------------------------


def test_liveness_touches_nothing_and_needs_no_credential(deployment):
    response = deployment.client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "alive"}


def test_readiness_reports_each_check_separately(deployment):
    response = deployment.client.get("/readyz")
    body = response.json()
    assert set(body["checks"]) == {"database", "schema", "object_store", "model_manifest"}
    # The schema check compares the recorded migrations against the files, and this application
    # runs against a harness-applied schema that records nothing, so it is expected to fail here.
    assert body["checks"]["database"]["ok"]
    assert body["checks"]["object_store"]["ok"]
    assert body["checks"]["model_manifest"]["ok"]
    # And it says what it does not prove, rather than letting a green tick imply it.
    assert "still exists in the live catalog" in body["checks"]["model_manifest"]["does_not_prove"]


def test_readiness_says_what_this_instance_is_running_without(deployment):
    body = deployment.client.get("/readyz").json()
    assert any("read-only" in warning for warning in body["warnings"])
    assert any("model credential" in warning for warning in body["warnings"])


# -- evidence -----------------------------------------------------------------------------


def test_a_citation_resolves_to_the_original_bytes(deployment):
    response = deployment.as_owner("GET", deployment.fill("/evidence/{span_id}"))
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/")
    assert response.content[:2] == b"\xff\xd8"
    assert response.headers["accept-ranges"] == "bytes"
    # Somebody's photograph must not land in a shared cache the deletion path cannot reach.
    assert "private" in response.headers["cache-control"]


def test_a_range_request_returns_that_range(deployment):
    whole = deployment.as_owner("GET", deployment.fill("/evidence/{span_id}"))
    part = deployment.as_owner(
        "GET", deployment.fill("/evidence/{span_id}"), headers={"Range": "bytes=0-9"}
    )
    assert part.status_code == 206
    assert part.content == whole.content[:10]
    assert part.headers["content-range"] == f"bytes 0-9/{len(whole.content)}"


def test_a_suffix_range_returns_the_tail(deployment):
    whole = deployment.as_owner("GET", deployment.fill("/evidence/{span_id}"))
    part = deployment.as_owner(
        "GET", deployment.fill("/evidence/{span_id}"), headers={"Range": "bytes=-5"}
    )
    assert part.status_code == 206
    assert part.content == whole.content[-5:]


@pytest.mark.parametrize("header", ["bytes=99999999-", "bytes=-", "items=0-1", "bytes=5-1"])
def test_an_unsatisfiable_range_is_refused_with_the_total(deployment, header):
    response = deployment.as_owner(
        "GET", deployment.fill("/evidence/{span_id}"), headers={"Range": header}
    )
    assert response.status_code == 416
    assert response.headers["content-range"].startswith("bytes */")


def test_a_permalink_from_another_workspace_is_not_readable(deployment):
    """A permalink names a blob by hash, so the workspace check cannot come from a row id."""
    listed = deployment.as_owner("POST", "/selection/packet", json={"intent": "captures"}).json()
    uri = listed["items"][0]["uri"]
    assert deployment.as_owner("GET", "/evidence", params={"uri": uri}).status_code == 200
    assert deployment.as_stranger("GET", "/evidence", params={"uri": uri}).status_code == 404


# -- selection ----------------------------------------------------------------------------


def test_a_selection_resolves_over_http(deployment):
    response = deployment.as_owner("POST", "/selection", json={"intent": "captures"})
    assert response.status_code == 200
    body = response.json()
    assert body["total_matched"] == 1
    assert body["captures"][0]["blob"].startswith("ni:///sha-256;")
    assert body["truncated"] is False


def test_a_malformed_plan_is_a_400_and_an_unknown_id_is_a_404(deployment):
    malformed = deployment.as_owner("POST", "/selection", json={"intent": "nonsense"})
    assert malformed.status_code == 422, "FastAPI rejects the body before the route runs"

    unknown = deployment.as_owner(
        "POST",
        "/selection",
        json={"intent": "captures", "entities": {"ids": [str(uuid.uuid4())], "mode": "any"}},
    )
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "unknown_reference"


def test_the_endpoints_that_need_a_model_say_so_rather_than_guessing(deployment):
    for path in ("/selection/plan", "/selection/ask"):
        response = deployment.as_owner("POST", path, json={"question": "where was I?"})
        assert response.status_code == 503
        assert "model credential" in response.json()["detail"]


# -- identity -----------------------------------------------------------------------------


def test_a_mutation_cannot_say_who_decided(deployment):
    """decided_by comes from the token. The request model has no field for it, so a caller that
    tried would be refused by the schema rather than ignored."""
    response = deployment.as_owner(
        "POST",
        "/identity/name",
        json={
            "occurrence_id": str(deployment.occurrence_id),
            "display_name": "Someone",
            "actor": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 422, response.text


def test_naming_an_already_identified_occurrence_is_a_conflict(deployment):
    response = deployment.as_owner(
        "POST",
        "/identity/name",
        json={"occurrence_id": str(deployment.occurrence_id), "display_name": "Someone else"},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "already_identified"


def test_agreeing_with_a_proposal_that_is_not_pending_is_refused(deployment):
    """The server half of "graph-client rejects any mutation whose proposal id is not pending"."""
    response = deployment.as_owner(
        "POST",
        "/identity/confirm",
        json={
            "occurrence_id": str(deployment.occurrence_id),
            "entity_id": str(deployment.entity_id),
            "proposal_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 409
    assert "still be pending" in response.json()["detail"]


def test_the_identity_ledger_is_readable(deployment):
    events = deployment.as_owner("GET", "/identity/events").json()
    assert [event["type"] for event in events][-2:] == ["entity_created", "link_confirmed"] or [
        event["type"] for event in events
    ][:2] == ["link_confirmed", "entity_created"]


# -- the scene grouping the client turns into islands ---------------------------------------


def _group_two_photographs(repository, photo_dir, store):
    """Ingest a second photograph an hour after the first, then cluster.

    Two photographs at one position an hour apart, which is inside the grouping window, so a
    correct clusterer returns one group of two and an incorrect one returns two groups of one.
    """
    from orimera.ingest.scenes import run_scene_grouping

    pipeline = PhotoIngestPipeline(repository, store, vision=None)
    outcome = pipeline.ingest_file(
        write_photo(photo_dir, "b.jpg", when="2026:08:27 11:00:00", gps=(64.3271, -20.1199))
    )
    assert outcome.error is None, outcome.error
    return run_scene_grouping(repository)


def test_the_graph_carries_the_grouping_the_client_turns_into_islands(
    deployment, repository, photo_dir
):
    """The server ships a grouping. It does not ship an island, and the difference is the point.

    ADR-0005 leaves what an island IS to the client, so what crosses the wire is named after the
    ingest artifact it is: a run of captures close in time and, where they had a fix, close in
    space. The client decides whether that is one region or several.
    """
    report = _group_two_photographs(repository, photo_dir, deployment.store)
    assert len(report.groups) == 1

    payload = deployment.as_owner("GET", "/graph").json()
    assert len(payload["scene_groups"]) == 1
    group = payload["scene_groups"][0]
    assert group["member_count"] == 2
    assert len(group["capture_ids"]) == 2
    assert group["first_utc"] < group["last_utc"]
    # No field on this payload is called an island, at any depth. The check is on the serialised
    # document rather than on the model, because a field added later to a nested row would be
    # just as much of a decision taken by accident.
    assert "island" not in json.dumps(payload).lower()


def test_a_deleted_capture_leaves_the_group_smaller_rather_than_dangling(
    deployment, repository, photo_dir
):
    """A group member the client cannot resolve is worse than a group with one fewer member.

    The client places anchors inside the islands it builds from these ids. An id naming a
    capture that no longer exists would be an island the interface knows the size of and can
    show nothing in.
    """
    _group_two_photographs(repository, photo_dir, deployment.store)
    before = deployment.as_owner("GET", "/graph").json()["scene_groups"][0]
    assert before["member_count"] == 2

    repository.connection.execute(
        "update capture set deleted_at = now() where capture_id = %s",
        (uuid.UUID(before["capture_ids"][0]),),
    )

    after = deployment.as_owner("GET", "/graph").json()["scene_groups"][0]
    assert after["member_count"] == 1
    assert after["capture_ids"] == before["capture_ids"][1:]


def test_a_stale_grouping_is_not_offered_at_all(deployment, repository, photo_dir):
    """Arranging a world out of a grouping known to be out of date is worse than arranging none.

    An empty list is a state the client already handles: with no grouping, every capture stands
    alone. A stale one is a state it cannot detect.
    """
    _group_two_photographs(repository, photo_dir, deployment.store)
    assert deployment.as_owner("GET", "/graph").json()["scene_groups"]

    repository.connection.execute(
        "update derived_artifact set stale = true where kind = 'scene_group'"
    )
    assert deployment.as_owner("GET", "/graph").json()["scene_groups"] == []

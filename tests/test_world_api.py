"""HTTP contract for adaptive-world preview, concurrency, rollback, and source states."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from orimera.api.app import create_app
from orimera.api.authorisation import load_token_directory
from orimera.api.services import Services
from orimera.store.local import LocalContentAddressedStore
from orimera.world import TopologyContract, TopologySourceSlot, WorldStyleRepository

pytestmark = pytest.mark.postgres

TOKEN = "world-owner-token-long-enough-for-tests"
STRANGER_TOKEN = "world-stranger-token-long-enough-for-tests"


@dataclass
class WorldApi:
    client: TestClient
    actor: uuid.UUID
    source_id: uuid.UUID

    @property
    def headers(self):
        return {"Authorization": f"Bearer {TOKEN}"}

    def get(self, path):
        return self.client.get(path, headers=self.headers)

    def stranger_get(self, path):
        return self.client.get(path, headers={"Authorization": f"Bearer {STRANGER_TOKEN}"})

    def post(self, path, body):
        return self.client.post(path, headers=self.headers, json=body)

    def delete(self, path):
        return self.client.delete(path, headers=self.headers)

    def current(self):
        return self.get("/world/styles/current").json()

    def preview_body(self, **overrides):
        current = self.current()
        body = {
            "proposal_id": str(uuid.uuid4()),
            "origin": "settings",
            "origin_reference": "appearance-panel",
            "scope": {"kind": "global"},
            "base_style_version_id": current["current"]["version_id"],
            "base_topology_digest": current["current_topology_digest"],
            "profile": {
                "profile_id": "origin-landscape",
                "profile_version": 1,
                "parameters": {"vitality": 0.25},
            },
        }
        body.update(overrides)
        return body


@pytest.fixture
def world_api(repository, spine_schema, tmp_path, monkeypatch):
    _psycopg, scratch = spine_schema
    actor = uuid.uuid4()
    stranger = uuid.uuid4()
    source_id = uuid.uuid4()
    styles = WorldStyleRepository(repository.connection, repository.workspace_id)
    styles.register_topology(
        TopologyContract(
            "api-topology",
            ("region-a",),
            (
                TopologySourceSlot(
                    source_id=source_id,
                    region_id="region-a",
                    slot_key="hero-memory",
                    evidence_span_id=None,
                    missing_reason="no evidence was recorded",
                ),
            ),
        )
    )
    monkeypatch.setenv(
        "ORIMERA_API_TOKENS",
        json.dumps(
            {
                TOKEN: {"workspace_id": str(repository.workspace_id), "actor": str(actor)},
                STRANGER_TOKEN: {
                    "workspace_id": str(stranger),
                    "actor": str(uuid.uuid4()),
                },
            }
        ),
    )
    from tests_support_api import scratch_database

    database = scratch_database(scratch)
    with database.session(stranger) as connection:
        WorldStyleRepository(connection, stranger).register_topology(
            TopologyContract("stranger-topology", ("region-a",))
        )
    services = Services(
        database=database,
        readonly_database=database,
        store=LocalContentAddressedStore(tmp_path / "blobs"),
        tokens=load_token_directory(),
        executor_shares_the_write_role=True,
        model_client=None,
    )
    with TestClient(create_app(services, verify=False)) as client:
        yield WorldApi(client, actor, source_id)


def test_catalog_and_current_state_expose_references_not_renderer_programs(world_api):
    catalog = world_api.get("/world/styles/catalog")
    assert catalog.status_code == 200
    text = catalog.text.lower()
    for forbidden in ("javascript", '"css"', '"shader"', '"layout"', "https://"):
        assert forbidden not in text

    state = world_api.current()
    assert state["current_topology_digest"] == "api-topology"
    assert state["current"]["revision"] == 0
    assert state["current"]["global_style"]["profile_id"] == "origin-landscape"


def test_preview_apply_discard_and_rollback_are_visible_as_immutable_versions(world_api):
    initial = world_api.current()
    preview = world_api.post("/world/styles/previews", world_api.preview_body())
    assert preview.status_code == 201, preview.text
    assert world_api.current()["current"]["version_id"] == initial["current"]["version_id"]

    applied = world_api.post(
        f"/world/styles/previews/{preview.json()['preview_id']}/apply",
        {
            "base_style_version_id": initial["current"]["version_id"],
            "base_topology_digest": "api-topology",
        },
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["revision"] == 1
    assert applied.json()["provenance"] == {
        "origin": "settings",
        "actor": str(world_api.actor),
        "origin_reference": "appearance-panel",
    }

    second = world_api.post("/world/styles/previews", world_api.preview_body())
    assert second.status_code == 201
    discarded = world_api.delete(f"/world/styles/previews/{second.json()['preview_id']}")
    assert discarded.status_code == 204
    assert world_api.current()["current"]["version_id"] == applied.json()["version_id"]

    rolled_back = world_api.post(
        "/world/styles/rollback",
        {
            "target_version_id": initial["current"]["version_id"],
            "base_style_version_id": applied.json()["version_id"],
            "base_topology_digest": "api-topology",
            "origin": "user",
        },
    )
    assert rolled_back.status_code == 200, rolled_back.text
    assert rolled_back.json()["revision"] == 2
    assert rolled_back.json()["rollback_target_version_id"] == initial["current"]["version_id"]
    assert [version["revision"] for version in world_api.get("/world/styles/versions").json()] == [
        0,
        1,
        2,
    ]


def test_style_topology_and_asset_failures_have_distinct_problem_codes(world_api):
    current = world_api.current()

    invalid = world_api.preview_body()
    invalid["profile"]["parameters"] = {"css": "body { display:none }"}
    response = world_api.post("/world/styles/previews", invalid)
    assert (response.status_code, response.json()["code"]) == (422, "invalid_style_data")

    stale = world_api.preview_body(base_style_version_id=str(uuid.uuid4()))
    response = world_api.post("/world/styles/previews", stale)
    assert (response.status_code, response.json()["code"]) == (409, "stale_style_version")

    topology = world_api.preview_body(base_topology_digest="old-topology")
    response = world_api.post("/world/styles/previews", topology)
    assert (response.status_code, response.json()["code"]) == (
        409,
        "protected_topology_conflict",
    )

    missing = world_api.get(f"/world/source-media/{world_api.source_id}")
    assert (missing.status_code, missing.json()["code"]) == (424, "unavailable_asset")

    unknown = world_api.get(f"/world/source-media/{uuid.uuid4()}")
    assert (unknown.status_code, unknown.json()["code"]) == (404, "unknown_reference")
    assert current["current"]["revision"] == 0


def test_source_listing_preserves_missing_evidence_instead_of_inventing_an_asset(world_api):
    response = world_api.get("/world/source-media")
    assert response.status_code == 200
    assert response.json() == [
        {
            "source_id": str(world_api.source_id),
            "slot_key": "hero-memory",
            "region_id": "region-a",
            "state": "missing_evidence",
            "reason": "no evidence was recorded",
            "evidence_span_id": None,
            "evidence_path": None,
            "modality": None,
            "media_type": None,
            "byte_size": None,
            "width": None,
            "height": None,
            "captured_at": None,
            "captured_at_uncertainty_ms": None,
        }
    ]


def test_source_metadata_is_workspace_authorised_without_becoming_an_existence_oracle(world_api):
    real = world_api.stranger_get(f"/world/source-media/{world_api.source_id}")
    invented = world_api.stranger_get(f"/world/source-media/{uuid.uuid4()}")
    assert real.status_code == invented.status_code == 404
    assert (
        real.json()
        == invented.json()
        == {
            "code": "unknown_reference",
            "detail": "no such world resource",
        }
    )


def test_the_request_cannot_choose_the_audit_actor(world_api):
    body = world_api.preview_body(actor=str(uuid.uuid4()))
    response = world_api.post("/world/styles/previews", body)
    assert response.status_code == 422

"""Cross-language and safety contracts for the reviewed world-style registry."""

from __future__ import annotations

import copy
import json
import pathlib
import re

import pytest
from orimera.world import STYLE_REGISTRY, InvalidStyleData, StyleReference, StyleRegistry

ROOT = pathlib.Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / "orimera" / "world" / "style-registry.v1.json"
CAPABILITIES_TS = ROOT / "web" / "packages" / "presentation" / "src" / "world-style-capabilities.ts"
PROFILES_TS = ROOT / "web" / "packages" / "presentation" / "src" / "world-profiles.ts"


def registry_document():
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def test_the_backend_registry_matches_the_committed_renderer_capability_vocabulary():
    source = CAPABILITIES_TS.read_text(encoding="utf-8")
    declared = set(re.findall(r"^  '([^']+)': Object\.freeze", source, re.MULTILINE))
    assert declared == set(STYLE_REGISTRY.capabilities)


def test_the_backend_registry_matches_the_committed_world_profile_versions():
    source = PROFILES_TS.read_text(encoding="utf-8")
    declared_ids = set(
        re.findall(r"profileId: '([^']+)'", source.split("export const WORLD_ART_PROFILES")[0])
    )
    assert declared_ids == {profile_id for profile_id, _version in STYLE_REGISTRY.profiles}
    assert {version for _profile_id, version in STYLE_REGISTRY.profiles} == {1}


def test_unknown_parameters_and_executable_payload_channels_are_not_style_data():
    for parameters in (
        {"css": "body { display: none }"},
        {"markup": "<script>alert(1)</script>"},
        {"shader": "void main() {}"},
        {"texture-url": "https://example.invalid/texture.png"},
        {"vitality": "url(https://example.invalid/a.png)"},
    ):
        with pytest.raises(InvalidStyleData):
            STYLE_REGISTRY.validate_reference(StyleReference("origin-landscape", 1, parameters))


def test_only_registered_capabilities_can_enter_a_profile_manifest():
    document = registry_document()
    document["profiles"][0]["controls"].append(
        {
            "key": "future-magic",
            "capability": "future.unknown",
            "kind": "range",
            "group": "world",
            "label": "Future magic",
            "description": "Not reviewed.",
            "min": 0,
            "max": 1,
            "step": 0.1,
            "default_value": 0.5,
        }
    )
    with pytest.raises(ValueError, match="unregistered"):
        StyleRegistry(document)


@pytest.mark.parametrize("status", ["removed", "unsupported"])
def test_removed_and_unsupported_profiles_have_one_deterministic_fallback(status):
    document = registry_document()
    document["profiles"].append(
        {
            "profile_id": "retired-study",
            "profile_version": 1,
            "display_name": "Retired study",
            "description": "A profile retained only so history resolves.",
            "compatibility_key": "atlas-topology-v1",
            "status": status,
            "fallback": {"profile_id": "origin-landscape", "profile_version": 1},
            "controls": [],
        }
    )
    registry = StyleRegistry(document)
    resolved, warnings = registry.resolve_reference(StyleReference("retired-study", 1, {}))
    assert resolved == registry.default_reference
    assert len(warnings) == 1
    assert status in warnings[0]


def test_an_unknown_historical_profile_falls_back_without_mutating_the_requested_value():
    requested = StyleReference("not-installed-anymore", 7, {"unknown": True})
    resolved, warnings = STYLE_REGISTRY.resolve_reference(requested)
    assert requested.profile_id == "not-installed-anymore"
    assert resolved == STYLE_REGISTRY.default_reference
    assert warnings == ("Unknown world profile not-installed-anymore@7; using origin-landscape@1.",)


def test_the_registry_is_metadata_not_interface_layout_or_renderer_programs():
    document = registry_document()
    serialized = json.dumps(document, sort_keys=True).lower()
    for forbidden in (
        '"css"',
        '"html"',
        '"markup"',
        '"javascript"',
        '"shader"',
        '"layout"',
        '"remote_url"',
        '"texture_url"',
    ):
        assert forbidden not in serialized


def test_a_profile_definition_cannot_widen_its_reviewed_capability_bounds():
    document = copy.deepcopy(registry_document())
    document["profiles"][0]["controls"][0]["max"] = 2
    with pytest.raises(ValueError, match="range definition"):
        StyleRegistry(document)

    document = copy.deepcopy(registry_document())
    document["profiles"][0]["controls"][0]["min"] = -1
    with pytest.raises(ValueError, match="range definition"):
        StyleRegistry(document)

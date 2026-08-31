from __future__ import annotations

import copy

import pytest
from orimera.world import InvalidStructuralData
from orimera.world.structure import (
    candidate_from_document,
    canonical_candidate_document,
    validate_candidate,
)

from world_structure_fixtures import structural_candidate, with_topology


def test_canonical_section_and_snapshot_digests_are_repeatable_and_self_verifying():
    first = structural_candidate()
    second = structural_candidate()
    assert validate_candidate(first) == validate_candidate(second)
    document = canonical_candidate_document(first)
    assert candidate_from_document(document) == first

    document["digests"]["topology_sha256"] = "0" * 64
    with pytest.raises(InvalidStructuralData, match="embedded digests"):
        candidate_from_document(document)


def test_float_coordinates_and_noncanonical_order_are_refused_before_hashing():
    candidate = structural_candidate()
    candidate.placement["elements"][0]["x_mm"] = 0.25
    with pytest.raises(InvalidStructuralData, match="fixed-point"):
        validate_candidate(candidate)

    candidate = structural_candidate()
    candidate.topology["regions"].reverse()
    with pytest.raises(InvalidStructuralData, match="sorted"):
        validate_candidate(candidate)


def test_required_destination_reachability_and_peer_collision_are_independent_gates():
    candidate = structural_candidate()
    topology = copy.deepcopy(candidate.topology)
    topology["navigation"]["edges"] = []
    with pytest.raises(InvalidStructuralData, match="unreachable"):
        validate_candidate(with_topology(candidate, topology))

    with pytest.raises(InvalidStructuralData, match="collision bodies overlap"):
        validate_candidate(structural_candidate(region_b_x_mm=1_000))

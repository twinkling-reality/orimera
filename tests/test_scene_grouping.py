"""Scene grouping, and the line between a proposal and a fact.

Grouping photographs by time and position is what turns a folder into somewhere the user has
been. It is also the easiest place in the system to quietly assert something: a cluster with a
confident label looks exactly like a known place. It is not one, and these tests pin that.
"""

from __future__ import annotations

import json
import uuid

import pytest
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.ingest.repository import IngestRepository
from orimera.ingest.scenes import group_captures, metres_between, run_scene_grouping
from orimera.store.local import LocalContentAddressedStore

from conftest import CountingVisionModel, write_photo

GULLFOSS = (643271000, -201199000)


def _capture(hour: int, minute: int = 0, position=None, day: int = 27):
    return {
        "capture_id": uuid.uuid4(),
        "utc_instant": f"2026-08-{day:02d}T{hour:02d}:{minute:02d}:00+00:00",
        "gps": {"lat_e7": position[0], "lon_e7": position[1]} if position else None,
    }


def test_a_long_gap_starts_a_new_scene():
    captures = [_capture(10, 0), _capture(10, 5), _capture(14, 0)]
    groups, ungrouped = group_captures(captures, max_time_gap_s=3600, max_distance_m=250)
    assert [len(g.capture_ids) for g in groups] == [2, 1]
    assert ungrouped == 0


def test_moving_far_enough_starts_a_new_scene_even_within_the_time_window():
    far = (GULLFOSS[0] + 100_000, GULLFOSS[1])  # about 1.1 km north
    captures = [_capture(10, 0, GULLFOSS), _capture(10, 5, GULLFOSS), _capture(10, 10, far)]
    groups, _ = group_captures(captures, max_time_gap_s=3600, max_distance_m=250)
    assert [len(g.capture_ids) for g in groups] == [2, 1]


def test_a_missing_position_is_unknown_and_not_treated_as_far_away():
    """Otherwise one photograph with GPS switched off splits every scene it lands in."""
    captures = [_capture(10, 0, GULLFOSS), _capture(10, 5, None), _capture(10, 10, GULLFOSS)]
    groups, _ = group_captures(captures, max_time_gap_s=3600, max_distance_m=250)
    assert len(groups) == 1
    assert len(groups[0].capture_ids) == 3
    assert len(groups[0].positions) == 2


def test_a_capture_with_no_timestamp_is_left_ungrouped_rather_than_guessed():
    captures = [_capture(10, 0), {"capture_id": uuid.uuid4(), "utc_instant": None, "gps": None}]
    groups, ungrouped = group_captures(captures, max_time_gap_s=3600, max_distance_m=250)
    assert ungrouped == 1
    assert sum(len(g.capture_ids) for g in groups) == 1


def test_the_centroid_and_radius_are_integers_computed_the_same_way_every_run():
    captures = [_capture(10, 0, GULLFOSS), _capture(10, 1, (GULLFOSS[0] + 1000, GULLFOSS[1]))]
    groups, _ = group_captures(captures, max_time_gap_s=3600, max_distance_m=250)
    first = groups[0]
    assert first.centroid == (GULLFOSS[0] + 500, GULLFOSS[1])
    assert isinstance(first.radius_m, int)
    assert metres_between(GULLFOSS, GULLFOSS) == 0.0


@pytest.fixture
def grouped(tmp_path, photo_dir, workspace_id):
    write_photo(photo_dir, "a.jpg", when="2026:08:27 10:00:00", gps=(64.3271, -20.1199))
    write_photo(
        photo_dir, "b.jpg", when="2026:08:27 10:05:00", gps=(64.3271, -20.1199), size=(120, 90)
    )
    write_photo(photo_dir, "c.jpg", when="2026:08:27 16:00:00", size=(100, 100))
    repository = IngestRepository.open(tmp_path / "ingest.db", workspace_id)
    store = LocalContentAddressedStore(tmp_path / "blobs")
    PhotoIngestPipeline(repository, store, vision=CountingVisionModel()).ingest_directory(photo_dir)
    return repository


def test_grouping_produces_derived_artifacts_that_record_what_they_came_from(grouped):
    report = run_scene_grouping(grouped)
    assert len(report.groups) == 2

    rows = grouped.connection.execute(
        "select kind, source_ids, dep_index, payload from derived_artifact order by kind"
    ).fetchall()
    kinds = [row["kind"] for row in rows]
    assert kinds.count("scene_group") == 2
    for row in rows:
        assert json.loads(row["source_ids"]), "a derived object must record its sources"
        assert json.loads(row["dep_index"])


def test_a_place_candidate_is_a_proposal_and_says_so(grouped):
    report = run_scene_grouping(grouped)
    assert report.proposals
    proposal = report.proposals[0]
    assert proposal["proposed_label"] == "Gullfoss"
    assert proposal["requires_user_confirmation"] is True
    assert proposal["epistemic_class"] == "inference"
    assert proposal["supporting_assertion_ids"]


def test_grouping_never_creates_an_entity(grouped):
    """Model confidence is never user confirmation, so promotion cannot happen here at all."""
    run_scene_grouping(grouped)
    tables = {
        row["name"]
        for row in grouped.connection.execute(
            "select name from sqlite_master where type='table'"
        ).fetchall()
    }
    assert "entity" not in tables
    kinds = {
        row["kind"]
        for row in grouped.connection.execute("select kind from derived_artifact").fetchall()
    }
    assert kinds <= {"scene_group", "place_proposal"}


def test_running_grouping_twice_writes_nothing_new(grouped):
    run_scene_grouping(grouped)
    before = grouped.count("derived_artifact")
    run_scene_grouping(grouped)
    assert grouped.count("derived_artifact") == before


def test_grouping_is_recorded_in_the_ledger_as_a_proposal_event(grouped):
    run_scene_grouping(grouped)
    types = [
        row["type"]
        for row in grouped.connection.execute(
            "select type from pipeline_event where stage_key = 'scene_group' or "
            "type = 'proposal_emitted'"
        ).fetchall()
    ]
    assert "proposal_emitted" in types
    assert "stage_succeeded" in types

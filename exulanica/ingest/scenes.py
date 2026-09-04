"""Scene grouping and place proposals.

A photograph library is not a flat set. Photographs cluster: a few minutes at one waterfall, an
hour later at a different one. Grouping them by EXIF time and GPS is what turns a folder into
somewhere the user has been.

**Everything this module produces is a proposal.** A scene-local grouping is not a persistent
entity, and a candidate place is not a place. Promotion requires explicit user confirmation, and
model confidence is never user confirmation. That is not a promise kept by care here: the ingest
data layer has no ``entity`` or ``entity_link`` table at all, so this code physically cannot
create one. Proposals land in ``derived_artifact``, which records what it was computed from, so
a later deletion invalidates exactly the proposals that named the deleted thing.

The thresholds are **unvalidated defaults**. They live in the stage params rather than in
constants precisely because the corpus has not been inspected: changing one changes the stage
key, so tuning them regenerates the groups instead of leaving stale ones behind.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import math
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Final

from orimera.ingest.ledger import Ledger
from orimera.ingest.repository import IngestRepository
from orimera.ingest.stages import ARTIFACT_NAMESPACE, stage

__all__ = ["SceneGroup", "SceneReport", "group_captures", "run_scene_grouping"]


#: The ``derived_artifact.kind`` this module writes its clustering under. Named rather than
#: repeated, because ``orimera.identity.signals`` reads the same string from a layer that may not
#: import this one, and a literal duplicated across a boundary nothing checks is a literal that
#: drifts. ``tests/test_match_proposals.py`` is the only place that can see both and it asserts
#: they are equal.
SCENE_GROUP_KIND: Final = "scene_group"


@dataclass
class SceneGroup:
    """A run of captures close in time, and close in space when both carry a position."""

    ordinal: int
    capture_ids: list[uuid.UUID] = field(default_factory=list)
    first_utc: str | None = None
    last_utc: str | None = None
    positions: list[tuple[int, int]] = field(default_factory=list)

    @property
    def centroid(self) -> tuple[int, int] | None:
        """Mean position in ten-millionths of a degree, or None when nothing had a fix.

        Integer arithmetic throughout. A centroid is a navigation aid, not evidence, but it
        still has no business drifting by a float epsilon between two runs over the same data.
        """
        if not self.positions:
            return None
        return (
            sum(lat for lat, _ in self.positions) // len(self.positions),
            sum(lon for _, lon in self.positions) // len(self.positions),
        )

    @property
    def radius_m(self) -> int | None:
        """Distance from the centroid to the furthest member, in whole metres."""
        centre = self.centroid
        if centre is None:
            return None
        return max(
            (int(metres_between(centre, position)) for position in self.positions), default=0
        )

    def as_payload(self) -> dict[str, Any]:
        centre = self.centroid
        payload: dict[str, Any] = {
            "ordinal": self.ordinal,
            "capture_ids": [str(capture_id) for capture_id in self.capture_ids],
            "first_utc": self.first_utc,
            "last_utc": self.last_utc,
            "member_count": len(self.capture_ids),
            "positioned_member_count": len(self.positions),
        }
        if centre is not None:
            payload["centroid_lat_e7"], payload["centroid_lon_e7"] = centre
            payload["radius_m"] = self.radius_m
        return payload

    @property
    def key(self) -> str:
        digest = hashlib.sha256()
        for capture_id in sorted(str(c) for c in self.capture_ids):
            digest.update(capture_id.encode("ascii"))
        return digest.hexdigest()


@dataclass
class SceneReport:
    groups: list[SceneGroup] = field(default_factory=list)
    proposals: list[dict[str, Any]] = field(default_factory=list)
    reconstruction_jobs: list[uuid.UUID] = field(default_factory=list)
    ungrouped: int = 0


_EARTH_RADIUS_M = 6_371_008.8


def metres_between(a: tuple[int, int], b: tuple[int, int]) -> float:
    """Great-circle distance between two positions given in ten-millionths of a degree."""
    lat1, lon1 = math.radians(a[0] / 1e7), math.radians(a[1] / 1e7)
    lat2, lon2 = math.radians(b[0] / 1e7), math.radians(b[1] / 1e7)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _parse(instant: str | None) -> dt.datetime | None:
    if not instant:
        return None
    try:
        return dt.datetime.fromisoformat(instant)
    except ValueError:
        return None


def group_captures(
    captures: list[dict[str, Any]], *, max_time_gap_s: int, max_distance_m: int
) -> tuple[list[SceneGroup], int]:
    """Cluster captures into scenes. Returns the groups and the count left ungrouped.

    A capture with no timestamp is left ungrouped rather than guessed into a neighbour. Time is
    the only ordering this corpus has, and a photograph with no clock has no place in a
    sequence; putting it somewhere plausible would be inventing the one fact the grouping is
    built on.

    A capture with no position is grouped on time alone. That is a genuine difference: a
    missing position is unknown, not far away, and treating unknown as a boundary would split
    every scene the moment one photograph had GPS switched off.
    """
    groups: list[SceneGroup] = []
    ungrouped = 0
    current: SceneGroup | None = None
    previous_time: dt.datetime | None = None

    for capture in captures:
        moment = _parse(capture.get("utc_instant"))
        if moment is None:
            ungrouped += 1
            continue
        gps = capture.get("gps") or {}
        position: tuple[int, int] | None = None
        if "lat_e7" in gps and "lon_e7" in gps:
            position = (int(gps["lat_e7"]), int(gps["lon_e7"]))

        starts_new = current is None or previous_time is None
        if not starts_new:
            assert current is not None and previous_time is not None
            if (moment - previous_time).total_seconds() > max_time_gap_s:
                starts_new = True
            else:
                centre = current.centroid
                if centre is not None and position is not None:
                    starts_new = metres_between(centre, position) > max_distance_m

        if starts_new:
            current = SceneGroup(ordinal=len(groups), first_utc=capture["utc_instant"])
            groups.append(current)
        assert current is not None
        current.capture_ids.append(capture["capture_id"])
        current.last_utc = capture["utc_instant"]
        if position is not None:
            current.positions.append(position)
        previous_time = moment

    return groups, ungrouped


def run_scene_grouping(
    repository: IngestRepository, *, ledger: Ledger | None = None
) -> SceneReport:
    """Group every live capture, and propose a place for each group that has evidence for one.

    Idempotent: the derived rows carry deterministic ids computed from the member capture set
    and the stage parameters, so a second run over an unchanged corpus writes nothing.
    """
    spec = stage(SCENE_GROUP_KIND)
    owns_ledger = ledger is None
    if ledger is None:
        ledger = Ledger.start_run(repository, trigger="ingest")
    captures = repository.captures_with_context()
    report = SceneReport()

    with ledger.stage(spec) as recorder:
        groups, ungrouped = group_captures(
            captures,
            max_time_gap_s=int(spec.params["max_time_gap_s"]),
            max_distance_m=int(spec.params["max_distance_m"]),
        )
        report.groups = groups
        report.ungrouped = ungrouped
        emitted: list[uuid.UUID] = []
        with repository.transaction():
            for group in groups:
                group_id = uuid.uuid5(
                    ARTIFACT_NAMESPACE,
                    f"scene_group:{spec.version}:{spec.params_digest.hex()}:{group.key}",
                )
                if repository.upsert_derived_artifact(
                    derived_id=group_id,
                    kind=SCENE_GROUP_KIND,
                    depends_on=[
                        {"kind": "capture", "id": str(capture_id)}
                        for capture_id in group.capture_ids
                    ],
                    dep_index=[f"capture:{capture_id}" for capture_id in group.capture_ids],
                    source_ids=group.capture_ids,
                    payload=group.as_payload(),
                ):
                    emitted.append(group_id)
                proposal = _place_proposal(repository, group, group_id, spec.version)
                if proposal is not None:
                    report.proposals.append(proposal["payload"])
                    if repository.upsert_derived_artifact(**proposal["row"]):
                        emitted.append(proposal["row"]["derived_id"])
        recorder.ledger.emitted("proposal", emitted, spec)

    # Import here because the policy names SceneGroup and this module owns that type. Keeping the
    # edge local avoids turning a type-level cycle into a package import cycle.
    from orimera.ingest.scene_selection import enqueue_scene_reconstructions

    selections = enqueue_scene_reconstructions(repository, report.groups)
    report.reconstruction_jobs = [selection.job_id for selection in selections]

    if owns_ledger:
        ledger.finish("succeeded")
    return report


def _place_proposal(
    repository: IngestRepository, group: SceneGroup, group_id: uuid.UUID, version: int
) -> dict[str, Any] | None:
    """Propose one place for a group, from the place labels its members already inferred.

    The proposal is the most-voted label, ties broken alphabetically so two runs over the same
    corpus agree. It carries the assertion ids it was drawn from, so the Atlas can show what
    supports it, and it carries ``requires_user_confirmation`` because it is not a fact and no
    amount of agreement between photographs makes it one.
    """
    rows = repository.place_inferences_for_captures(group.capture_ids)
    if not rows:
        return None
    votes = Counter(row["label"] for row in rows)
    top = sorted(votes.items(), key=lambda item: (-item[1], item[0]))[0][0]
    supporting = [row for row in rows if row["label"] == top]
    payload = {
        "proposed_label": top,
        "votes": votes[top],
        "candidate_labels": dict(sorted(votes.items())),
        "scene_group_id": str(group_id),
        "capture_ids": [str(capture_id) for capture_id in group.capture_ids],
        "supporting_assertion_ids": [str(row["assertion_id"]) for row in supporting],
        # Not a fact, and structurally not promotable from here: this pipeline has no entity
        # table. A person has to say yes.
        "requires_user_confirmation": True,
        "epistemic_class": "inference",
        "trust_tier": "T2",
    }
    derived_id = uuid.uuid5(ARTIFACT_NAMESPACE, f"place_proposal:{version}:{group_id}:{top}")
    return {
        "payload": payload,
        "row": {
            "derived_id": derived_id,
            "kind": "place_proposal",
            "depends_on": [{"kind": SCENE_GROUP_KIND, "id": str(group_id)}]
            + [{"kind": "capture", "id": str(c)} for c in group.capture_ids],
            "dep_index": [f"scene_group:{group_id}"] + [f"capture:{c}" for c in group.capture_ids],
            "source_ids": group.capture_ids,
            "payload": payload,
        },
    }

"""Record the rung earned by a reconstruction scene.

``reconstruction_scene`` is the set of photographs a reconstruction was run over. It is a
different subject from :mod:`orimera.ingest.scenes`, which records a ``scene_group`` proposal
produced by time-and-space clustering. A group's worst member rung is useful for panels. A
reconstruction scene's rung is supported by the members that registered and is never a reduction
over the individual photographs' rungs.

The producer passes the durable gate decision that it stored beside the pose and placement
receipts. This writer does not recalculate or improve that result. Registered members support a
placed scene claim. When no member registered, every input photograph supports the rung-4 claim
that the set remains source photographs rather than an inference with no cited evidence.
"""

from __future__ import annotations

import uuid

from orimera.epistemics.vocabulary import RECONSTRUCTION_SCENE_RUNG_PREDICATE
from orimera.evidence import EvidenceAddress
from orimera.ingest.repository import IngestRepository
from orimera.reconstruction.scene_gate import SceneGateDecision

__all__ = ["record_scene_rung"]


def record_scene_rung(
    repository: IngestRepository,
    *,
    scene_id: uuid.UUID,
    run_id: uuid.UUID,
    decision: SceneGateDecision,
) -> uuid.UUID | None:
    """Publish the exact durable gate decision, after checking it against scene membership."""
    members = repository.reconstruction_scene_members(scene_id)
    registered = [member for member in members if member.registered is True]
    if decision.member_count != len(members) or decision.registered_member_count != len(registered):
        raise ValueError("the scene gate member counts disagree with durable scene membership")
    supporting = registered or members
    support_span_ids = [
        repository.upsert_span(EvidenceAddress.photograph(member.blob_id))
        for member in supporting
    ]
    return repository.insert_assertion(
        kind="inference",
        predicate_key=RECONSTRUCTION_SCENE_RUNG_PREDICATE,
        subject_ref={"type": "scene", "id": str(scene_id)},
        object_value={
            "rung": decision.rung,
            "reasons": list(decision.reasons),
            "member_count": decision.member_count,
            "registered_member_count": decision.registered_member_count,
            "gate_digest": decision.digest,
        },
        emit_key=f"scene-rung:{scene_id}:{decision.digest}",
        support_span_ids=support_span_ids,
        produced_by_run=run_id,
    )

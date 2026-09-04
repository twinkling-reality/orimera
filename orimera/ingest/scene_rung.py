"""Record the rung earned by a reconstruction scene.

``reconstruction_scene`` is the set of photographs a reconstruction was run over. It is a
different subject from :mod:`orimera.ingest.scenes`, which records a ``scene_group`` proposal
produced by time-and-space clustering. A group's worst member rung is useful for panels. A
reconstruction scene's rung is supported by the members that registered and is never a reduction
over the individual photographs' rungs.

Rung 3 is the only honest scene-level claim available before ADR-0009 D1's receipt gate exists.
The registered member set is the measurement: each support span says one whole photograph was
placed relative to the others. Rungs 1 and 2 require receipt thresholds that are not measured
yet, while a set with no registered members carries no rung at all and is refused by the shared
inference support rule.
"""

from __future__ import annotations

import uuid
from typing import Final

from orimera.epistemics.vocabulary import RECONSTRUCTION_SCENE_RUNG_PREDICATE
from orimera.evidence import EvidenceAddress
from orimera.ingest.repository import IngestRepository

__all__ = ["record_scene_rung"]


_REASONS: Final = [
    "Rungs 1 and 2 are awarded only by ADR-0009 D1's receipt gate, and that gate is not built.",
    (
        "Every pose, scale, coverage, corridor and splat threshold that gate would read is "
        "unmeasured."
    ),
]


def record_scene_rung(
    repository: IngestRepository, *, scene_id: uuid.UUID, run_id: uuid.UUID
) -> uuid.UUID | None:
    """Publish rung 3 over the registered members, or refuse when none registered."""
    members = repository.reconstruction_scene_members(scene_id)
    support_span_ids = [
        repository.upsert_span(EvidenceAddress.photograph(member.blob_id))
        for member in members
        if member.registered is True
    ]
    return repository.insert_assertion(
        kind="inference",
        predicate_key=RECONSTRUCTION_SCENE_RUNG_PREDICATE,
        subject_ref={"type": "scene", "id": str(scene_id)},
        object_value={
            "rung": 3,
            "reasons": list(_REASONS),
            "member_count": len(members),
        },
        # D1 will include its gate decision digest when that decision exists. Until then the
        # registered set is deterministic, so retrying this write is the same emission.
        emit_key=f"scene-rung:{scene_id}",
        support_span_ids=support_span_ids,
        produced_by_run=run_id,
    )

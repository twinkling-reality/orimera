"""What runs over the whole corpus once the photographs are in, and the runs it closes.

Two passes, and neither can be computed from one photograph. Scene grouping asks which captures
belong together in time and place, and match proposals ask which unlinked detections might be
somebody already named. Both are relations between captures, so both run after the photographs
rather than inside any one of them.

**They live here because two callers need them identically.** ``exulanica-ingest`` runs them at
the end of a directory and :mod:`exulanica.ingest.worker` runs them at the end of a queued job,
and a second copy of this is a second place for the batch id, the run bracketing and the order
to drift.

**Each pass gets its own run and this module closes it.** That sentence is the reason the module
exists rather than being two lines in each caller. ``run_scene_grouping`` finishes the run only
when it opened it, and ``propose_matches`` takes a run id and cannot finish anything, because
``Ledger`` lives in ``exulanica.ingest`` and the identity layer may not import it. So a caller that
hands either of them a run it opened owns closing it, and both callers previously did not:
measured on a real end-to-end upload, every batch left two ``pipeline_run`` rows in ``running``
for ever. Nothing downstream read the column, which is exactly why it stayed wrong; the ledger
is the one thing in this system that is supposed to be true about what happened.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from exulanica.identity.proposer import ProposalReport, propose_matches
from exulanica.identity.repository import IdentityRepository
from exulanica.identity.signals import ContextSignals
from exulanica.ingest.ledger import Ledger
from exulanica.ingest.repository import IngestRepository
from exulanica.ingest.scenes import SceneReport, run_scene_grouping

__all__ = ["ContinuityReport", "run_continuity"]


@dataclass(frozen=True, slots=True)
class ContinuityReport:
    """What the two passes found, so a caller can print it without repeating the calls."""

    scenes: SceneReport
    proposals: ProposalReport


def run_continuity(
    repository: IngestRepository, *, batch_id: uuid.UUID | None = None
) -> ContinuityReport:
    """Group the corpus into scenes, then ask the questions the new photographs raise.

    ``batch_id`` is the watched intake these passes belong to, or None for an unwatched run.
    Passing it is what puts continuity search in the formation stream as the stage it is: left
    out, a person watching a region form sees the pipeline stop after entity indexing and then
    finish, with no account of what happened in between.

    The order is not interchangeable. Scene grouping writes the place proposals that
    ``context_place`` scores against, so proposing matches first would score against the
    previous run's scenes.
    """
    scenes_run = Ledger.start_run(repository, trigger="ingest", batch_id=batch_id)
    try:
        scenes = run_scene_grouping(repository, ledger=scenes_run)
    except Exception:
        scenes_run.finish("failed")
        raise
    scenes_run.finish("succeeded")

    proposals_run = Ledger.start_run(repository, trigger="ingest", batch_id=batch_id)
    try:
        proposals = propose_matches(
            IdentityRepository(repository.connection, repository.workspace_id),
            ContextSignals.read(repository.connection, repository.workspace_id),
            run_id=proposals_run.run_id,
        )
    except Exception:
        proposals_run.finish("failed")
        raise
    proposals_run.finish("succeeded")

    return ContinuityReport(scenes=scenes, proposals=proposals)

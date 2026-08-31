"""What a number from this harness may say, and what it may not.

``docs/evaluation-methodology.md`` is the specification and section 3 is the part that governs
this package: nine mechanically enforceable rules about what may be claimed from a measurement,
and an overclaiming checklist that is a review gate on external copy. The rules that can be
enforced by code are enforced here rather than trusted to whoever writes the summary.

**This package sits ABOVE the HTTP API and it is the only thing that does.** M10 specifies its
authorisation sweep as "table-driven, generated from the router, so a new route without a test
fails CI", and a harness that cannot see the router hand-enumerates routes. That is not a
hypothetical failure: it happened, when FastAPI stopped flattening included routers and a
one-level walk quietly stopped seeing the entire authenticated surface. So the layering says, in
one sentence: nothing the product runs depends on the API, and the only thing that does is the
thing that measures it.

**The corpus problem, first and loudest.** The only corpus that exists is synthetic: eighty
renders of three geometric arrangements. Nothing about identity, clustering or reconstruction is
real on it. No number computed against it is evidence about photographs, no interval is printed
against it, and the report says all of that above the results rather than in a footnote.
"""

from __future__ import annotations

from orimera.evaluation.bundle import (
    AccessPurpose,
    AccessReceipt,
    AuthorizedSource,
    CorpusBundle,
    CorpusContractError,
    CorpusItem,
)
from orimera.evaluation.counts import Count, NamedCase, Sample, render, wilson
from orimera.evaluation.execution import execution_snapshot
from orimera.evaluation.ground_truth import Frame, GroundTruth
from orimera.evaluation.metrics import METRICS, Component
from orimera.evaluation.provenance import (
    ArchiveError,
    ArchiveReceipt,
    create_archive,
    verify_archive,
)
from orimera.evaluation.report import BANNED, banned_words_in, render_report

__all__ = [
    "BANNED",
    "METRICS",
    "AccessPurpose",
    "AccessReceipt",
    "ArchiveError",
    "ArchiveReceipt",
    "AuthorizedSource",
    "Component",
    "CorpusBundle",
    "CorpusContractError",
    "CorpusItem",
    "Count",
    "Frame",
    "GroundTruth",
    "NamedCase",
    "Sample",
    "banned_words_in",
    "create_archive",
    "execution_snapshot",
    "render",
    "render_report",
    "verify_archive",
    "wilson",
]

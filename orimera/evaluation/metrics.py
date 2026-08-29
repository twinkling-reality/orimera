"""Every component of every metric, and what a result for it may and may not license.

One row per row of ``docs/evaluation-methodology.md`` section 6, because that is the unit the
methodology actually classifies. ``kind`` cannot hang off a metric: section 6.1 lists "M8 parse,
execution, schema validity" as enforced and section 6.2 lists "M8 plan semantic accuracy" as
learned, and the same split runs through M1 and M5. A per-metric kind would force a choice the
document deliberately refuses to make.

``licenses`` and ``withholds`` are copied verbatim, and the second is the one that matters. It is
what stops a report being read as more than it is, and section 6.1's entry for M10 authorization
is the clearest example in the document: the sweep licenses "no cross-tenant read succeeded on
any route generated from the router" and explicitly does NOT license that anonymous asset URLs are
protected. "They are not, and the report says so."
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

__all__ = ["METRICS", "Component"]

Kind = Literal["enforced", "learned", "unclassified"]


@dataclass(frozen=True, slots=True)
class Component:
    """One scoreable component of one metric."""

    metric: str
    key: str
    name: str
    kind: Kind
    #: The section 6 target, verbatim, or None where the document sets none.
    bar: str | None
    licenses: str | None
    withholds: str | None
    #: None when the component is runnable. A sentence when it is not, and the sentence names
    #: what is missing rather than describing the component as unimplemented. A blocked metric is
    #: a different fact from a metric that scored zero.
    blocked_on: str | None = None


METRICS: Final[tuple[Component, ...]] = (
    Component(
        "M1", "cit_id", "citation resolves to the exact original", "enforced", "1.00",
        "Every citation in OGC-1 opened the exact original photograph that supports the claim",
        "Any statement about photographs outside OGC-1, or about region-level precision within a "
        "photograph",
        blocked_on=None,
    ),
    Component(
        "M1", "cit_region", "region-level citation precision", "unclassified", None, None, None,
        blocked_on="section 6 places this in neither acceptance table, and no browser harness "
        "exists to measure a rendered region: the web workspace has no Playwright",
    ),
    Component(
        "M2", "hallucination_rate", "unsupported claims per answered question", "learned",
        "0 on the answerable set",
        "Zero unsupported claims across the N answerable questions in OGC-1, bounding the true "
        "rate at <= X% (95% Wilson upper)",
        '"Orimera does not hallucinate." The bound is the claim',
        blocked_on="no question set exists. The gold question fixture is unwritten, so there is "
        "no answerable set to score against",
    ),
    Component(
        "M3", "false_answer_rate", "answered an unanswerable question", "learned", "0",
        "The system abstained on every unanswerable question in OGC-1",
        "Abstention behaviour on question types not represented",
        blocked_on="no question set exists, and one of the three abstention reason codes has no "
        "producer, so a third of the space cannot be reached even with one",
    ),
    Component(
        "M3", "false_abstention_rate", "abstained on an answerable question", "learned",
        "<= 2 in 35 (rescaled to final n)",
        "The system answered all but K answerable questions",
        "A general willingness-to-answer rate",
        blocked_on="no gold question set exists, so there is no answerable question that the "
        "system could have abstained on",
    ),
    Component(
        "M4", "person_recall_at_5", "gold-same person pair within the top 5", "learned", "1.00",
        "Every gold-SAME person pair in OGC-1 appeared within the top 5 candidates",
        "Any recall claim on a larger gallery, other people, or other conditions. Gallery size is "
        "the whole difficulty and this gallery is tiny",
        blocked_on="face embeddings are blocked on a human decision recorded as open in "
        "privacy-consent-threat-model.md section 10, and the synthetic corpus carries no people",
    ),
    Component(
        "M4", "false_candidate_rate", "false candidates among those surfaced", "learned",
        "<= 0.25",
        "One in four surfaced candidates was a false candidate at the demonstration threshold, "
        "on OGC-1",
        "Anything, if theta was tuned on OGC-1. In that case it is a fit and is labelled as one",
        blocked_on="the same human decision, and there is no labelled cross-capture pair set",
    ),
    Component(
        "M5", "provenance_completeness", "every confirmed edge carries evidence", "enforced",
        "1.00",
        "Every edge in the confirmed graph carries at least one evidence pointer",
        "That the edges are correct. Correctness is M5 precision and recall, a separate, learned "
        "number",
        blocked_on=None,
    ),
    Component(
        "M6", "filter_set_exact_match", "ANY, ALL and TOGETHER return the gold set", "enforced",
        "100%",
        "ANY, ALL and TOGETHER filters return the exact gold set on every expression tested",
        "Correct behaviour on filter expressions not in the suite",
        blocked_on=None,
    ),
    Component(
        "M7", "copresence_windows", "predicted against gold participant sets", "learned",
        "named case studies",
        "Here are the predicted and gold participant sets and intervals for each window",
        "Any aggregate. Never an F1 over a handful of windows",
        blocked_on="co-presence needs two confirmed people in one capture and the corpus has no "
        "people at all",
    ),
    Component(
        "M8", "plan_validity", "parse, execution and schema validity", "enforced", "1.00 each",
        "Every query compiled to a schema-valid, executable plan",
        "That the plan expressed the question. That is M8 semantic accuracy, a human-labelled "
        "number with a 0.90 bar",
        blocked_on="no question set exists, and planning calls a model, so it needs a credential "
        "and three runs per rule 2",
    ),
    Component(
        "M8", "plan_semantic_accuracy", "the plan expressed the question", "learned", ">= 0.90",
        "K of N plans expressed the question, human-labelled",
        "Semantic accuracy on question phrasings outside the set",
        blocked_on="human labelling, which no harness can supply",
    ),
    Component(
        "M9", "gate_precision", "no external lookup on a personal entity or a past question",
        "enforced", "0 false invocations",
        "No external lookup occurred for any private entity, any historical question, or with "
        "opt-in off, across the tested negatives",
        "That the gate is unbreakable. It licenses only that these negatives did not break it",
        blocked_on=None,
    ),
    Component(
        "M9", "payload_minimality", "only a public entity name left the system", "enforced",
        "pass",
        "The only content that left the system for external lookup was a public entity name",
        "Anything about what the external provider does with it",
        blocked_on="no external lookup path is implemented, so there is no payload to inspect",
    ),
    Component(
        "M10", "deletion", "every logged artifact absent after deletion", "enforced",
        "100% of logged artifacts absent",
        "Every artifact logged at ingestion was verifiably absent after deletion",
        '"Your data is gone." Backups, exported packages, and anything already published are '
        "outside this test and are disclosed separately",
        blocked_on="the purge worker is not implemented. `purge_job` is a table nothing reads, "
        "which is defect R7",
    ),
    Component(
        "M10", "authorisation", "no cross-tenant read on any route", "enforced",
        "0 unauthorized reads",
        "No cross-tenant read succeeded on any route generated from the router",
        "That anonymous asset URLs are protected. They are not, and the report says so",
        blocked_on=None,
    ),
    Component(
        "M11", "injection_resistance", "no probe produced a policy violation", "enforced",
        "0 violations",
        "No probe in the OGC-1 injection corpus produced a policy violation, and K of N were "
        "blocked architecturally",
        '"Injection resistant." OWASP states plainly that no complete defence exists',
        blocked_on="two of the four channels do not exist. There are no transcripts, and nothing "
        "writes `user_annotation`, so only the OCR channel is reachable",
    ),
    Component(
        "M12", "upload_to_ready_latency", "upload to a walkable region", "unclassified", None,
        None, None,
        blocked_on="section 6 places this in neither acceptance table, and there is no upload "
        "endpoint to measure from",
    ),
    Component(
        "M13", "answer_latency", "first token and resolvable citations", "learned",
        "first token p50 <= 1.5 s; answer with resolvable citations p95 <= 8 s",
        "Measured from [region] against [model IDs] on OGC-1",
        "Latency under load. The suite is sequential and single-user",
        blocked_on="no question set exists and answering calls a model",
    ),
    Component(
        "M14", "frame_time", "browser frame time and memory", "learned",
        "OPEN until measured on real hardware", None,
        "Nothing yet. No rendering number is a target until real hardware is measured",
        blocked_on="no browser harness exists and no hardware target has been chosen",
    ),
)

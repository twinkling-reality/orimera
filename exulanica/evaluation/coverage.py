"""What this corpus can support a metric over, and what it cannot.

This is not a scorer and it produces no number that is compared against a bar. It produces the
sentences the report prints under "WHAT IS NOT COVERED", computed against the workspace rather
than typed into a string, because a coverage claim that was true when somebody wrote it is a
coverage claim nobody re-checked.

**Why the subject join lives here rather than in a scorer.** ``MANIFEST.json`` records, per
subject, the phrases a detector might use for it, and that mapping was built so M6 could be
scored against the corpus. M6 turned out not to be a corpus metric at all: it filters on
confirmed entity ids, an entity exists only where a person confirmed one, and a harness that
confirmed from ground truth would be writing a user's decision to make its own number
computable. The mapping survives that, and its job changed. It is now the instrument that
measures WHY a manifest-derived filter metric would not have been worth having: run it and it
reports how much of the corpus's own placement the detector's vocabulary can even see.

That number belongs in the report rather than in a document, because a document records what
was true on the day somebody measured it and this recomputes on every run. It is a disclosure
and never a score: nothing here is compared against a target, and a low number is a fact about
the vision stage's vocabulary rather than a failure of anything the report scores.
"""

from __future__ import annotations

import re
import uuid

import psycopg

from orimera.evaluation.ground_truth import GroundTruth

__all__ = ["subject_of", "what_the_corpus_cannot_support"]


def subject_of(label: str, mapping: dict[str, tuple[str, ...]]) -> str | None:
    """Which subject a detector's label means, or None when the corpus cannot say.

    The rule, stated because a matching rule nobody wrote down is a matching rule nobody can
    argue with: a label means a subject when the label, lowercased, contains one of that
    subject's phrases as a whole-word run. Containment rather than equality, because a model
    that says "a small red cube on the platform" is describing the corpus's satchel correctly and
    refusing to join that would be scoring the model down for being right about pixels.

    **A label that matches two subjects means neither.** Ambiguity has to resolve to nothing, or
    the mapping manufactures matches: "cube" appears in the appearance words of more than one
    subject, and letting it count for the first one iterated would make the result depend on
    dictionary order. None is the honest answer and it costs a detection, not a correctness
    claim.
    """
    words = re.findall(r"[a-z0-9]+", label.lower())
    haystack = " " + " ".join(words) + " "
    matched = {
        subject
        for subject, phrases in mapping.items()
        if any(
            f" {' '.join(re.findall(r'[a-z0-9]+', phrase.lower()))} " in haystack
            for phrase in phrases
        )
    }
    return matched.pop() if len(matched) == 1 else None


def what_the_corpus_cannot_support(
    connection: psycopg.Connection, workspace: uuid.UUID, truth: GroundTruth
) -> tuple[str, ...]:
    """The measured coverage sentences, one per line, for the report's disclosure section.

    Two facts, and they are the two that decide which metrics a corpus run may carry.

    *   **How many confirmed entities this workspace holds.** Every filter over a person, an
        object or a place needs one, and an entity exists only where a person confirmed an
        occurrence. This counts them rather than asserting there are none, because a workspace a
        real user has worked in may hold some.
    *   **How much of the corpus's own placement the detector's vocabulary recovers.** Per
        subject: the frames the generator placed it in, and the frames where a stored label
        resolves back to it. The gap between those is the vision stage's recall, and it is
        printed because it is the whole argument against building an entity filter metric on a
        manifest-derived gold set: such a metric would report this recall under a name that says
        filters.
    """
    entities = connection.execute(
        "select count(*) as n from entity where workspace_id = %s and deleted_at is null",
        (workspace,),
    ).fetchone()
    assert entities is not None
    lines = [
        f"CONFIRMED ENTITIES IN THIS WORKSPACE: {int(entities['n'])}. Every filter over a "
        "person, an object or a place needs one, and an entity exists only where a person "
        "confirmed an occurrence. Nothing in this harness confirms anything."
    ]

    if not truth.subject_labels:
        lines.append(
            "This corpus's manifest carries no subject-to-label mapping, so what a detector "
            "recovered of the generator's placements cannot be measured here."
        )
        return tuple(lines)

    stored: dict[str, set[str]] = {}
    for row in connection.execute(
        "select c.blob_sha256, a.object_value #>> '{}' as label "
        "from assertion a join predicate p on p.predicate_id = a.predicate_id "
        "join capture c on c.capture_id::text = a.subject_ref ->> 'id' "
        "where a.workspace_id = %s and p.key = 'object_present' and a.status = 'active'",
        (workspace,),
    ).fetchall():
        stored.setdefault(bytes(row["blob_sha256"]).hex(), set()).add(row["label"])

    # Scoped to THIS corpus, because a workspace can hold several and the others carry their own
    # detections. A workspace-wide count reads as "objects were detected" while none of them is
    # in the corpus being described.
    in_corpus = {frame.sha256 for frame in truth.frames}
    resolved = {
        digest: {
            subject
            for label in labels
            if (subject := subject_of(label, truth.subject_labels)) is not None
        }
        for digest, labels in stored.items()
        if digest in in_corpus
    }
    if not resolved:
        lines.append(
            "No object was detected in any frame of this corpus, so nothing can be said about "
            "what a detector recovered of the generator's placements."
        )
        return tuple(lines)

    lines.append(
        "WHAT A DETECTOR RECOVERED OF THE GENERATOR'S PLACEMENTS, which is why no filter metric "
        "is scored against a manifest-derived gold set. Per subject: the frames the generator "
        "placed it in, and the frames where a stored label resolves back to it."
    )
    for subject in sorted(truth.subjects):
        gold = {frame.sha256 for frame in truth.frames if subject in frame.subjects}
        got = {digest for digest, subjects in resolved.items() if subject in subjects}
        lines.append(
            f"    {subject}: placed in {len(gold)}, recovered in {len(gold & got)}, "
            f"resolved in {len(got - gold)} the generator did not place it in"
        )
    return tuple(lines)

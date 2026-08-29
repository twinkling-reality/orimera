"""The five components that can be scored today, and nothing that cannot.

Each one returns a ``Count`` with every case named, because section 3.1 rule 4 asks for failures
by name with their evidence rather than for an aggregate. A component that cannot run is not
here: it is a row in ``metrics.py`` carrying the sentence that says what is missing, because
"blocked" and "scored zero" are different facts and a harness that reported them alike would be
the same defect this project keeps finding elsewhere.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from collections.abc import Callable

import psycopg

from orimera.evaluation.counts import Count, NamedCase
from orimera.evaluation.ground_truth import GroundTruth

__all__ = [
    "score_authorisation",
    "score_citation_identity",
    "score_filter_sets",
    "score_gate_precision",
    "score_provenance_completeness",
]


def score_citation_identity(
    connection: psycopg.Connection,
    workspace: uuid.UUID,
    truth: GroundTruth,
    read_blob: Callable[[bytes], bytes | None],
) -> Count:
    """M1 CIT-ID. Every span resolves to the exact original bytes the manifest names.

    The join is by content address, never by filename, which is the reason the manifest is keyed
    that way. What is being measured is that a citation opens the exact original, so the check
    reads the bytes back out of the store and hashes them: a row that merely points at a hash
    would be checking the database against itself.

    A span whose bytes are NOT in the manifest is not scored and is not a failure. It is a
    capture this corpus has no ground truth for, which happens whenever a workspace holds more
    than one corpus, and counting it as a failed citation would report the harness's own blind
    spot as the product's defect. The count of unscoreable spans is returned as a passing case so
    the number appears in the report rather than being silently dropped: a reader has to be able
    to see that 80 of 327 spans were in scope.
    """
    rows = connection.execute(
        "select distinct blob_sha256 from evidence_span where workspace_id = %s",
        (workspace,),
    ).fetchall()
    by_hash = truth.by_hash
    cases: list[NamedCase] = []
    outside = 0
    for row in rows:
        digest = bytes(row["blob_sha256"]).hex()
        frame = by_hash.get(digest)
        if frame is None:
            outside += 1
            continue
        payload = read_blob(bytes(row["blob_sha256"]))
        if payload is None:
            cases.append(NamedCase(frame.filename, False, "the cited bytes are not in the store"))
            continue
        recomputed = hashlib.sha256(payload).hexdigest()
        cases.append(
            NamedCase(
                frame.filename,
                recomputed == frame.sha256,
                "" if recomputed == frame.sha256 else f"store holds {recomputed[:12]}",
            )
        )
    scored = Count(sum(case.passed for case in cases), len(cases), tuple(cases))
    if outside:
        # Reported, not dropped. "80 of 80 in scope, 247 spans outside this corpus" and
        # "80 of 327" are different facts and only the first one is true.
        scored = Count(
            scored.k,
            scored.n,
            (
                NamedCase(
                    f"{outside} spans in this workspace are outside the corpus and were not "
                    "scored, because there is no ground truth for them",
                    True,
                ),
                *scored.cases,
            ),
        )
    return scored


def score_provenance_completeness(
    connection: psycopg.Connection, workspace: uuid.UUID
) -> Count:
    """M5. Every edge in the confirmed graph carries at least one evidence pointer.

    It licenses nothing about whether the edges are CORRECT. That is a learned number and it is
    not this one, and section 6.1 says so in the row this scorer implements.
    """
    rows = connection.execute(
        "select l.link_id, o.span_ids from entity_link l "
        "join occurrence o on o.occurrence_id = l.occurrence_id "
        "where l.workspace_id = %s and l.state = 'confirmed'",
        (workspace,),
    ).fetchall()
    cases = [
        NamedCase(
            str(row["link_id"])[:8],
            bool(row["span_ids"]),
            "" if row["span_ids"] else "a confirmed edge with no evidence pointer",
        )
        for row in rows
    ]
    return Count(sum(case.passed for case in cases), len(cases), tuple(cases))


def _subject_of(label: str, mapping: dict[str, tuple[str, ...]]) -> str | None:
    """Which subject a detector's label means, or None when the corpus cannot say.

    The rule, stated because a matching rule nobody wrote down is a matching rule nobody can
    argue with: a label means a subject when the label, lowercased, contains one of that
    subject's phrases as a whole-word run. Containment rather than equality, because a model
    that says "a small red cube on the platform" is describing the corpus's satchel correctly and
    refusing to join that would be scoring the model down for being right about pixels.

    **A label that matches two subjects means neither.** Ambiguity has to resolve to nothing, or
    the mapping manufactures matches: "cube" appears in the appearance words of more than one
    subject, and letting it count for the first one iterated would make the gold comparison
    depend on dictionary order. None is the honest answer and it costs a detection, not a
    correctness claim.
    """
    words = re.findall(r"[a-z0-9]+", label.lower())
    haystack = " " + " ".join(words) + " "
    matched = {
        subject
        for subject, phrases in mapping.items()
        if any(f" {' '.join(re.findall(r'[a-z0-9]+', phrase.lower()))} " in haystack
               for phrase in phrases)
    }
    return matched.pop() if len(matched) == 1 else None


def score_filter_sets(
    connection: psycopg.Connection, workspace: uuid.UUID, truth: GroundTruth
) -> tuple[Count | None, str]:
    """M6. ANY, ALL and TOGETHER return the exact gold set on every expression tested.

    **This does not score, and the reason is not the one it used to be.** The old reason was that
    the corpus named its subjects and the detector named appearances and nothing joined them.
    That gap is closed: ``MANIFEST.json`` now carries ``subject_labels`` and :func:`_subject_of`
    resolves one vocabulary into the other. The mapping was necessary and it is not sufficient,
    and having built it the honest thing is to say what is actually in the way.

    **A Selection filters on confirmed entity ids.** ``EntitySelector.ids`` is "resolved entity
    ids only": the surface that produced the plan already turned a name into an id, and ANY, ALL
    and TOGETHER are statements about entities. The synthetic corpus has occurrences and **no
    entities at all**, because promotion from an occurrence to a persistent entity requires
    explicit user confirmation and nothing has confirmed anything. A harness that confirmed them
    from ground truth would be writing ``user``-class decisions on a person's behalf to make its
    own number computable, which is invariant 3 read backwards.

    **And the shape it had could not have failed.** ``got`` was a set comprehension over the rows
    this function had just read, compared against the manifest. No plan was built, no validator
    ran and the executor was never called, so a filter defect could not make it fail and a
    correct filter could not make it pass. What it compared was the detector's vocabulary against
    the generator's placements, under a name that says filters. Set algebra over the real
    executor is tested, in ``tests/test_selection.py``, which is where M6's traps live.

    What is returned instead is a refusal carrying measured numbers rather than a guess, because
    "blocked" and "scored zero" are different facts and the report holds both.
    """
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
    # detections. A workspace-wide emptiness check reads as "objects were detected" while none of
    # them is in the corpus being scored.
    in_corpus = {frame.sha256 for frame in truth.frames}
    stored = {digest: labels for digest, labels in stored.items() if digest in in_corpus}
    if not stored:
        # Nothing detected an object in any frame of this corpus, so there is nothing for a
        # filter to return and the gold set has no counterpart. Scoring it as "0 of 6, all
        # missing" would report an absent input as a query defect, which is the same mistake as
        # counting an out-of-scope span as a failed citation.
        return None, (
            "no object was detected in any frame of this corpus, so there is nothing for a "
            "filter to return"
        )

    if not truth.subject_labels:
        return None, (
            "this corpus's manifest carries no subject-to-label mapping, so the subjects it "
            f"names, {sorted(truth.subjects)}, cannot be joined to what the pipeline recorded. "
            "Regenerate the corpus with `orimera-corpus`, which writes one"
        )

    resolved = {
        digest: {
            subject
            for label in labels
            if (subject := _subject_of(label, truth.subject_labels)) is not None
        }
        for digest, labels in stored.items()
    }
    # The measured facts the refusal carries, so it says how far away this is rather than only
    # that it is away. `ingested` matters on its own: a gold set over eighty frames compared
    # against a workspace holding eight scores every filter as failing for a reason that is the
    # harness's own, which is the shape this file exists to avoid.
    ingested = len(stored)
    recovered = sum(1 for subjects in resolved.values() if subjects)
    entities = connection.execute(
        "select count(*) as n from entity where workspace_id = %s", (workspace,)
    ).fetchone()
    return None, (
        f"a Selection filters on confirmed entity ids and this workspace has {int(entities['n'])} "
        f"of them. {ingested} of the corpus's {len(truth.frames)} frames are ingested and the "
        f"manifest's subject-to-label mapping resolves a subject in {recovered} of them, so the "
        "join between the two vocabularies is no longer what is missing. What is missing is a "
        "confirmed entity per subject, and confirming them from ground truth would be this "
        "harness writing user decisions on a person's behalf to make its own number computable. "
        "Set algebra over the real executor is tested in tests/test_selection.py"
    )


def score_gate_precision(connection: psycopg.Connection, workspace: uuid.UUID) -> Count:
    """M9. No external lookup occurred for any private entity or historical question.

    Measured as: no ``external``-class assertion exists in the workspace. On this build that is
    trivially true because no external lookup path is implemented, and the report says so rather
    than presenting a vacuous pass as a defended one. It becomes a real measurement the day one
    is, and it fails immediately if a lookup ever writes without a gate.
    """
    rows = connection.execute(
        "select count(*) as n from assertion where workspace_id = %s and kind = 'external'",
        (workspace,),
    ).fetchone()
    invocations = int(rows["n"])
    return Count(
        1 if invocations == 0 else 0,
        1,
        (
            NamedCase(
                "no external-class claim in the workspace",
                invocations == 0,
                "" if invocations == 0 else f"{invocations} external claims were written",
            ),
        ),
    )


def score_authorisation(
    probe: Callable[[str, str], tuple[int, object]],
    routes: list[tuple[str, str]],
    public: set[str],
) -> Count:
    """M10. No cross-tenant read succeeded on any route generated from the router.

    ``routes`` comes from ``orimera.api.routes.routable_paths`` rather than from a list here,
    which is what M10's own specification requires and what stopped this sweep going blind once
    already.

    TWO KINDS OF ROUTE AND TWO PASS CONDITIONS, because one rule gets the second kind wrong.

    *   A route addressed by an id is a resource. A stranger must receive 404 and never 403, so
        the surface is not an existence oracle: a foreign id and an invented one have to be
        indistinguishable from outside.
    *   A route with no id in it is a collection scoped to the caller's own workspace. A stranger
        asking for their own graph gets their own graph, which is empty, and 200 is the correct
        answer. Requiring 404 there would be requiring the API to pretend the caller does not
        exist. What must be true is that the body carries none of the owner's records, so that is
        what is checked.

    The first version of this scorer applied the resource rule to everything and reported
    ``GET /graph`` and ``GET /formation`` as cross-tenant reads. They were not: they were empty.
    """
    cases: list[NamedCase] = []
    for method, path in routes:
        if path in public:
            continue
        status, body = probe(method, path)
        if "{" in path:
            allowed = status in (404, 422)
            evidence = "" if allowed else f"a stranger received {status} for a foreign id"
        else:
            allowed = status in (404, 422) or _is_empty_of_records(body)
            evidence = (
                "" if allowed else f"a stranger received {status} carrying records: {body!r:.120}"
            )
        cases.append(NamedCase(f"{method} {path}", allowed, evidence))
    return Count(sum(case.passed for case in cases), len(cases), tuple(cases))


def _is_empty_of_records(body: object) -> bool:
    """Does this response carry nothing belonging to anybody?

    A collection route answers a stranger with the stranger's own scope, and the stranger owns
    nothing, so every list in the body must be empty. Scalars are ignored: a state version or a
    count is not somebody's record.
    """
    if isinstance(body, list):
        return not body
    if isinstance(body, dict):
        return all(_is_empty_of_records(value) for value in body.values())
    return True

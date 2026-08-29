"""The evaluation harness, and the rules it is supposed to enforce on itself.

A harness that overclaims is worse than no harness, because a number carries authority a
paragraph does not. So most of what is tested here is refusal: refusing an interval over nothing,
refusing a failure with no evidence, refusing a measurement from one run of a stochastic system,
and refusing to print a word section 3.1 rule 9 bans.
"""

from __future__ import annotations

import io
import pathlib

import pytest
from orimera.evaluation import (
    METRICS,
    Count,
    GroundTruth,
    NamedCase,
    Sample,
    banned_words_in,
    render,
    render_report,
    wilson,
)
from orimera.evaluation.report import quoted_from_the_methodology

CORPUS = pathlib.Path(__file__).resolve().parents[1] / ".orimera" / "media" / "intake" / "synthetic"


# -- the rules that are refusals ------------------------------------------------------------


def test_a_failure_with_no_evidence_is_refused():
    """Rule 4. A failure reported without the case that produced it is a number nobody can check.

    The only thing anybody can do with such a number is believe it, which is the opposite of
    what this harness is for.
    """
    NamedCase("a passing case", True)
    NamedCase("a failing case", False, "here is what went wrong")
    with pytest.raises(ValueError, match="carries no evidence"):
        NamedCase("a failing case", False)


def test_one_run_of_a_stochastic_component_is_refused():
    """Rule 2. "A single run of a stochastic system is not a measurement."

    The refusal is in the type rather than in the caller, because the caller is where "just this
    once" gets written.
    """
    runs = (Count(1, 1), Count(1, 1), Count(0, 1))
    Sample(runs)
    with pytest.raises(ValueError, match="at least three"):
        Sample(runs[:2])


def test_an_interval_over_nothing_is_refused():
    """A zero must say which zero it is.

    ``[0, 1]`` renders "nothing was scored" and "everything failed" identically, which is exactly
    the conflation this project refuses everywhere else.
    """
    with pytest.raises(ValueError, match="not an interval"):
        wilson(0, 0)


def test_the_interval_reproduces_the_methodology_worked_example():
    """52 of 52 -> [93.1%, 100%], the one example in the document that reproduces at all.

    The other two worked intervals it prints match no standard interval this was checked
    against. They are recorded as open items against the document and this code is not bent to
    hit them.
    """
    low, high = wilson(52, 52)
    assert round(low * 100, 1) == 93.1
    assert round(high * 100, 1) == 100.0


# -- rendering ------------------------------------------------------------------------------


def test_a_synthetic_corpus_never_gets_an_interval():
    """An interval describes a sample drawn from a population, and a render is not one.

    It describes how faithfully a generator does what it was written to do, which is not a fact
    about photographs and must not be printed as one.
    """
    text = render(Count(40, 40), synthetic=True, corpus_tag="SYNTH-1")
    assert "no interval" in text
    assert "CI" not in text


def test_a_small_sample_prints_its_cases_instead_of_a_percentage():
    """Rule 3, and the renderer does it rather than every caller remembering to."""
    count = Count(1, 2, (NamedCase("first", True), NamedCase("second", False, "because")))
    text = render(count, synthetic=False, corpus_tag="OGC-1")
    assert "%" not in text
    assert "second: FAIL  because" in text


def test_every_number_carries_the_corpus_it_was_measured_on():
    """Rule 2 of 3.1: the corpus name travels with every number, into every surface."""
    assert "OGC-1" in render(Count(9, 10), synthetic=False, corpus_tag="OGC-1")
    assert "SYNTH-1" in render(Count(9, 10), synthetic=True, corpus_tag="SYNTH-1")


# -- the metric table -------------------------------------------------------------------------


def test_every_metric_the_methodology_defines_has_at_least_one_component():
    """A report missing a metric reads as a clean one. Fourteen appear or the table is wrong."""
    covered = {component.metric for component in METRICS}
    assert covered == {f"M{number}" for number in range(1, 15)}, sorted(covered)


def test_a_component_that_cannot_run_says_what_stopped_it():
    """Blocked and scored-zero are different facts, and the table has to hold the difference."""
    for component in METRICS:
        if component.blocked_on is not None:
            assert len(component.blocked_on) > 30, component.key


def test_an_enforced_component_carries_the_bar_it_is_measured_against():
    for component in METRICS:
        if component.kind == "enforced":
            assert component.bar, component.key
            assert component.licenses, component.key
            assert component.withholds, component.key


def test_the_report_says_what_a_result_does_not_license():
    """Section 6's third column is the one that stops a report being read as more than it is.

    M10's is the clearest: the sweep licenses that no cross-tenant read succeeded on a route
    generated from the router, and explicitly not that anonymous asset URLs are protected.
    """
    report = _report({})
    assert "does NOT license" in report
    assert "asset URLs are protected. They are not" in report


# -- the banned vocabulary --------------------------------------------------------------------


def _report(results: dict) -> str:
    return render_report(
        results,
        corpus_tag="SYNTH-1",
        corpus_version="orimera-corpus 1",
        manifest_sha256="0" * 64,
        synthetic=True,
        disclosure="a synthetic frame",
        frames=80,
        git_commit="abc1234",
    )


def test_the_scan_catches_a_banned_word():
    assert banned_words_in("this system is reliable") == ["reliable"]
    assert banned_words_in("measured on OGC-1") == []
    # Whole words only: a substring inside another word is not the claim rule 9 forbids.
    assert banned_words_in("reliability engineering") == []


def test_the_report_refuses_to_print_a_banned_word():
    """The check runs unconditionally, over the report, every time it is rendered.

    An earlier design scanned the whole documentation set, found 85 hits it could not adjudicate,
    and put the scan behind a flag. A check nobody turns on is not a check.
    """
    with pytest.raises(ValueError, match="rule 9"):
        render_report(
            {},
            corpus_tag="SYNTH-1",
            corpus_version="v",
            manifest_sha256="0" * 64,
            synthetic=True,
            disclosure="this corpus is fully deleted",
            frames=1,
            git_commit="abc",
        )


def test_the_exemption_is_exactly_the_quoted_cells_and_nothing_else():
    """The scan steps over section 6's verbatim text, and the exemption has to be enumerable.

    Rule 9 bans those words as CAPABILITY CLAIMS, and the "does not license" column is the
    anti-claim column: scanning it would forbid the report from saying something is NOT
    guaranteed. So the quotations are exempt, and this asserts the exemption is those cells and
    not a hole somebody could widen.
    """
    quoted = set(quoted_from_the_methodology())
    from_table = {
        text
        for component in METRICS
        for text in (component.licenses, component.withholds, component.bar)
        if text
    }
    assert quoted == from_table


def test_a_banned_word_outside_a_quotation_is_still_caught():
    """The exemption must not become a way to smuggle a claim in beside a quotation."""
    with pytest.raises(ValueError, match="rule 9"):
        render_report(
            {},
            corpus_tag="SYNTH-1",
            corpus_version="v",
            manifest_sha256="0" * 64,
            synthetic=True,
            disclosure="the store is immutable",
            frames=1,
            git_commit="abc",
        )


# -- the ground truth join ---------------------------------------------------------------------


@pytest.mark.skipif(not CORPUS.exists(), reason="the synthetic corpus has not been generated")
def test_the_manifest_is_keyed_by_the_hash_ingest_computes():
    """Which is the whole reason an evaluation can join to a stored capture by evidence address.

    A filename is a thing a user renames. The content hash is what the system keys on, so a join
    on it measures the system rather than a naming convention.
    """
    truth = GroundTruth.read(CORPUS)
    assert len(truth.frames) == len(truth.by_hash), "two frames share a hash"
    for frame in truth.frames:
        assert len(frame.sha256) == 64


@pytest.mark.skipif(not CORPUS.exists(), reason="the synthetic corpus has not been generated")
def test_the_manifest_records_which_frames_can_be_placed_on_a_timeline():
    """So the unknown-offset case is scored without crediting the pipeline for guessing.

    One device in the corpus writes ``OffsetTimeOriginal`` and one does not. A frame from the
    second has a wall clock reading in the file and no way to place it, and a pipeline that
    produced an instant for it would be inventing one.
    """
    from orimera.evaluation.ground_truth import instant_is_correct

    truth = GroundTruth.read(CORPUS)
    recoverable = [f for f in truth.frames if f.instant_is_recoverable_from_the_file]
    unrecoverable = [f for f in truth.frames if not f.instant_is_recoverable_from_the_file]
    assert recoverable and unrecoverable, "the corpus no longer covers both cases"

    passed, _ = instant_is_correct(unrecoverable[0], None)
    assert passed, "storing no instant for an unplaceable frame is the correct behaviour"
    guessed, why = instant_is_correct(unrecoverable[0], "2026-04-18T09:14:21+00:00")
    assert not guessed and "guessed rather than read" in why

# -- M6: the two vocabularies, and what is still in the way ----------------------------------


def test_a_detector_label_resolves_to_the_subject_the_corpus_placed():
    """The join the manifest now makes possible, and the rule it makes it by.

    Containment rather than equality, because a model that says "a small red cube on the
    platform" is describing the corpus's satchel correctly, and refusing to join that would be
    scoring the model down for being right about pixels.
    """
    from orimera.corpus.world import SUBJECT_LABELS
    from orimera.evaluation.scorers import _subject_of

    assert _subject_of("a small red cube", SUBJECT_LABELS) == "satchel"
    assert _subject_of("the teal cylinder on the shelf", SUBJECT_LABELS) == "thermos"
    assert _subject_of("amber prism", SUBJECT_LABELS) == "lantern"
    assert _subject_of("BAG", SUBJECT_LABELS) == "satchel", "the rule is case-insensitive"


def test_a_label_that_could_mean_two_subjects_means_neither():
    """Ambiguity must resolve to nothing, or the mapping manufactures matches.

    "cube" appears in the appearance words of more than one subject. Letting it count for
    whichever is iterated first would make a gold comparison depend on dictionary order, which is
    a number that changes for a reason nobody could explain.
    """
    from orimera.corpus.world import SUBJECT_LABELS
    from orimera.evaluation.scorers import _subject_of

    assert _subject_of("cube", SUBJECT_LABELS) is None
    assert _subject_of("red cube beside a gold cube", SUBJECT_LABELS) is None
    assert _subject_of("octagonal platform", SUBJECT_LABELS) is None


def test_the_generated_manifest_carries_the_mapping_the_scorer_needs():
    """A pin across the boundary between the corpus generator and the harness that reads it."""
    import json
    import tempfile
    from pathlib import Path

    from orimera.corpus.__main__ import main as corpus_main
    from orimera.corpus.world import SUBJECT_LABELS
    from orimera.evaluation.ground_truth import GroundTruth

    with tempfile.TemporaryDirectory() as directory:
        corpus_main(["--out", directory, "--frames-per-trip", "3"], stream=io.StringIO())
        document = json.loads((Path(directory) / "MANIFEST.json").read_text())
        assert document["subject_labels"] == {
            key: list(labels) for key, labels in SUBJECT_LABELS.items()
        }
        truth = GroundTruth.read(directory)
        assert truth.subject_labels == SUBJECT_LABELS


def test_a_manifest_written_before_the_mapping_existed_still_reads():
    """Absent is a real state and it is not an error. M6 is then blocked for the older reason."""
    import json
    import tempfile
    from pathlib import Path

    from orimera.evaluation.ground_truth import GroundTruth

    with tempfile.TemporaryDirectory() as directory:
        (Path(directory) / "MANIFEST.json").write_text(
            json.dumps(
                {
                    "generator": "g",
                    "synthetic": True,
                    "disclosure": "d",
                    "trips": [],
                    "places": {},
                    "subjects": {"satchel": "a bag"},
                    "frames": [],
                }
            )
        )
        assert GroundTruth.read(directory).subject_labels == {}

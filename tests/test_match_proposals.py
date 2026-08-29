"""Automatic match proposals, from context and never from biometrics.

Before this, ``match_proposal`` was written by nothing and identity was rung one: the account
holder says who somebody is. These tests are the second rung, and the thing they are most
concerned with is the rule that stops it becoming a nag.

Decision id-4: a rejected match is never re-proposed identically, and a proposal built from
genuinely DIFFERENT signals is still permitted to ask again. That is a subset test over modality
sets, and until migration 0008 it could not be computed at all: ``identity_rejection`` stored a
digest and no modality list, and a digest is opaque. What existed was digest equality, which
under-suppresses in the dangerous direction, because ``basis_digest`` covers extractor versions
and a version bump would therefore revive every rejection the user had already answered.
"""

from __future__ import annotations

import uuid

import pytest
from orimera.epistemics.assertions import AssertionWriter
from orimera.identity import IdentityRepository, confirm_link, name_occurrence, reject_link
from orimera.identity.proposer import PROPOSER_PARAMS, propose_matches
from orimera.identity.signals import (
    SCENE_GROUP_KIND,
    CaptureContext,
    ContextSignals,
    corroborating_modalities,
)

pytestmark = pytest.mark.postgres


def test_the_scene_group_kind_is_the_one_ingest_writes():
    """A literal duplicated across a boundary nothing checks is a literal that drifts.

    ``orimera.identity`` may not import ``orimera.ingest``: the layer contract makes them
    siblings. So the ``derived_artifact.kind`` string is written in one and read in the other,
    and this test is the only thing that can see both. It needs no database, which is why it
    would still catch the drift on a machine with no server.
    """
    from orimera.ingest.scenes import SCENE_GROUP_KIND as ingest_kind

    assert ingest_kind == SCENE_GROUP_KIND


def _context(
    *,
    capture: uuid.UUID | None = None,
    lat: float | None = None,
    lon: float | None = None,
    groups: frozenset[uuid.UUID] = frozenset(),
    labels: frozenset[str] = frozenset(),
) -> CaptureContext:
    return CaptureContext(
        capture_id=capture or uuid.uuid4(),
        started_at=None,
        lat=lat,
        lon=lon,
        scene_group_ids=groups,
        object_labels=labels,
    )


# -- the signals, which need no database ---------------------------------------------------


def test_two_captures_at_the_same_place_corroborate_on_place():
    near = _context(lat=51.5007, lon=-0.1246)
    also_near = _context(lat=51.5009, lon=-0.1244)
    assert corroborating_modalities(
        near, also_near, join_label="red cube", max_place_distance_m=250, min_shared_labels=2
    ) == ("context_place",)


def test_a_capture_with_no_position_corroborates_nothing_on_place():
    """"We do not know where this was taken" is not "these were taken far apart".

    The corpus has an indoor trip with no GPS at all, so this is the normal case rather than an
    edge one, and a sentinel distance would quietly let the first behave like the second.
    """
    positioned = _context(lat=51.5007, lon=-0.1246)
    unknown = _context()
    assert (
        corroborating_modalities(
            positioned, unknown, join_label=None, max_place_distance_m=250, min_shared_labels=2
        )
        == ()
    )


def test_captures_far_apart_corroborate_nothing():
    london = _context(lat=51.5007, lon=-0.1246)
    edinburgh = _context(lat=55.9533, lon=-3.1883)
    assert (
        corroborating_modalities(
            london, edinburgh, join_label=None, max_place_distance_m=250, min_shared_labels=2
        )
        == ()
    )


def test_the_join_label_is_not_counted_as_its_own_evidence():
    """Twenty-seven captures containing a red cube do not contain the same red cube.

    The label is the hard constraint that decides which pairs are worth comparing. Counting it in
    the shared-label set would make the constraint corroborate itself, and every red cube in the
    library would be proposed as the same cube with a straight face.
    """
    group = uuid.uuid4()
    a = _context(labels=frozenset({"red cube"}))
    b = _context(labels=frozenset({"red cube"}))
    assert (
        corroborating_modalities(
            a, b, join_label="red cube", max_place_distance_m=250, min_shared_labels=1
        )
        == ()
    )
    # The same pair, sharing something that is NOT the join key, does corroborate.
    c = _context(labels=frozenset({"red cube", "a bench"}))
    d = _context(labels=frozenset({"red cube", "a bench"}))
    assert corroborating_modalities(
        c, d, join_label="red cube", max_place_distance_m=250, min_shared_labels=1
    ) == ("context_cooccurrence",)
    # And a shared scene group corroborates on its own.
    e = _context(groups=frozenset({group}))
    f = _context(groups=frozenset({group}))
    assert corroborating_modalities(
        e, f, join_label="red cube", max_place_distance_m=250, min_shared_labels=99
    ) == ("context_cooccurrence",)


# -- the producer, against a real database -------------------------------------------------


@pytest.fixture
def corpus(repository):
    """Two captures, each with one 'person' occurrence, at the same place and in one group.

    Built by hand rather than by ingest, because what is under test is the proposer and a vision
    model in the loop would make the fixture about the detector instead.
    """
    from orimera.evidence import EvidenceAddress
    from orimera.evidence.blob import BlobId
    from orimera.identity.keys import occurrence_identity_key
    from orimera.ingest.ledger import Ledger

    run = Ledger.start_run(repository, trigger="ingest")
    captures: list[uuid.UUID] = []
    occurrences: list[uuid.UUID] = []
    for index in range(2):
        blob = BlobId.of_bytes(f"photo-{index}".encode())
        repository.upsert_blob(blob, byte_size=8, media_type="image/jpeg", storage_key=f"k{index}")
        capture = repository.insert_capture(blob, device_id="probe", started_at=None)
        address = EvidenceAddress.photograph(blob)
        span = repository.upsert_span(address)
        occurrence = repository.insert_occurrence(
            capture_id=capture.capture_id,
            occurrence_class="person",
            primary_span_id=span,
            span_ids=[span],
            presence=[(0, 1)],
            produced_by_run=run.run_id,
            detector_version="probe:1",
            identity_key=occurrence_identity_key(address, "person"),
            emit_key=f"probe:o:{index}",
            quality={"label": "person", "confidence_band": "high"},
        )
        captures.append(capture.capture_id)
        occurrences.append(occurrence)

    # One scene group holding both, which is what makes them corroborate on co-occurrence.
    repository.upsert_derived_artifact(
        derived_id=uuid.uuid4(),
        kind=SCENE_GROUP_KIND,
        depends_on=[{"kind": "capture", "id": str(c)} for c in captures],
        dep_index=[f"capture:{c}" for c in captures],
        source_ids=list(captures),
        payload={"capture_ids": [str(c) for c in captures], "ordinal": 0},
    )
    return repository, run.run_id, captures, occurrences


def _name_first(repository, occurrence_id: uuid.UUID, actor: uuid.UUID) -> uuid.UUID:
    identity = IdentityRepository(repository.connection, repository.workspace_id)
    named = name_occurrence(
        identity,
        AssertionWriter(repository.connection, repository.workspace_id),
        occurrence_id=occurrence_id,
        display_name="Julie",
        actor=actor,
    )
    return named.entity_id


def _propose(repository, run_id: uuid.UUID):
    identity = IdentityRepository(repository.connection, repository.workspace_id)
    signals = ContextSignals.read(repository.connection, repository.workspace_id)
    return identity, propose_matches(identity, signals, run_id=run_id)


def test_naming_one_person_produces_a_question_about_the_other_capture(corpus):
    """The whole point. Before this, nothing wrote a match proposal at all."""
    repository, run_id, _captures, occurrences = corpus
    actor = uuid.uuid4()
    _name_first(repository, occurrences[0], actor)

    identity, report = _propose(repository, run_id)
    assert report.anchors == 1
    assert report.candidates == 1
    assert len(report.surfaced) == 1, report

    pending = identity.pending_proposal(
        occurrence_id=occurrences[1],
        entity_id=_entity_of(identity, occurrences[0]),
    )
    assert pending is not None
    assert pending["basis"]["modalities"] == ["context_cooccurrence"]


def _entity_of(identity: IdentityRepository, occurrence_id: uuid.UUID) -> uuid.UUID:
    link = identity.link_for_occurrence(occurrence_id)
    assert link is not None
    return link.entity_id


def test_a_second_pass_asks_no_second_question(corpus):
    """Idempotent by the emit key, which is keyed on the question and not on the answer."""
    repository, run_id, _captures, occurrences = corpus
    _name_first(repository, occurrences[0], uuid.uuid4())
    _identity, first = _propose(repository, run_id)
    _identity, second = _propose(repository, run_id)
    assert len(first.surfaced) == 1
    assert second.written == 0, "a re-run wrote a proposal that was already there"


def test_rejecting_a_proposal_suppresses_the_same_basis_and_not_a_different_one(corpus):
    """Decision id-4, which is the reason migration 0008 stores a modality list.

    Rejecting on ``{context_cooccurrence}`` must suppress a later proposal built from exactly
    that, and must NOT suppress one that carries a modality the user was never shown. Under
    digest equality alone the first half fails the moment a version bumps.
    """
    repository, run_id, _captures, occurrences = corpus
    actor = uuid.uuid4()
    _name_first(repository, occurrences[0], actor)
    identity, _ = _propose(repository, run_id)
    entity_id = _entity_of(identity, occurrences[0])

    pending = identity.pending_proposal(occurrence_id=occurrences[1], entity_id=entity_id)
    assert pending is not None
    reject_link(
        identity,
        occurrence_id=occurrences[1],
        entity_id=entity_id,
        actor=actor,
        basis_digest=bytes(pending["basis_digest"]),
        basis_modalities=pending["basis"]["modalities"],
    )

    occurrence = identity.occurrence(occurrences[1])
    assert occurrence is not None
    suppressed, new_modality = identity.rejection_covering(
        scope="occurrence_entity",
        key_a=occurrence.identity_key,
        key_b=entity_id.bytes,
        modalities=("context_cooccurrence",),
    )
    assert suppressed is True
    assert new_modality is None

    # A genuinely different signal set is still permitted to ask, and says what is new.
    permitted, fresh = identity.rejection_covering(
        scope="occurrence_entity",
        key_a=occurrence.identity_key,
        key_b=entity_id.bytes,
        modalities=("context_cooccurrence", "context_place"),
    )
    assert permitted is False
    assert fresh == "context_place"


def test_a_user_who_was_shown_nothing_suppresses_everything(corpus):
    """An unprompted no carries NULL modalities, not an empty list, and the two are opposite.

    An empty array is a subset of nothing, so it would suppress no future proposal at all and a
    GPS coincidence could overrule a person about their own life. NULL, read through the guard,
    suppresses every basis. A zero must say which zero it is.
    """
    repository, _run_id, _captures, occurrences = corpus
    actor = uuid.uuid4()
    entity_id = _name_first(repository, occurrences[0], actor)
    identity = IdentityRepository(repository.connection, repository.workspace_id)

    reject_link(identity, occurrence_id=occurrences[1], entity_id=entity_id, actor=actor)
    occurrence = identity.occurrence(occurrences[1])
    assert occurrence is not None
    for modalities in (("context_place",), ("context_cooccurrence", "context_place", "user_text")):
        suppressed, _ = identity.rejection_covering(
            scope="occurrence_entity",
            key_a=occurrence.identity_key,
            key_b=entity_id.bytes,
            modalities=modalities,
        )
        assert suppressed is True, modalities


def test_a_suppressed_proposal_is_recorded_rather_than_silently_skipped(corpus):
    """"Why is it not asking me about this" has to be answerable."""
    repository, run_id, _captures, occurrences = corpus
    actor = uuid.uuid4()
    entity_id = _name_first(repository, occurrences[0], actor)
    identity = IdentityRepository(repository.connection, repository.workspace_id)
    reject_link(identity, occurrence_id=occurrences[1], entity_id=entity_id, actor=actor)

    _identity, report = _propose(repository, run_id)
    assert len(report.suppressed) == 1, report
    assert report.surfaced == []
    outcome = repository.connection.execute(
        "select outcome from match_proposal where workspace_id = %s",
        (repository.workspace_id,),
    ).fetchone()
    assert outcome["outcome"] == "suppressed_by_rejection"


def test_confirming_withdraws_every_live_rejection_for_the_pair(corpus):
    """Otherwise a machine rejection outlives the confirmation that contradicted it.

    The user rejected on one basis and then said yes. Leaving that no live would suppress future
    proposals about a pair they have now confirmed.
    """
    repository, run_id, _captures, occurrences = corpus
    actor = uuid.uuid4()
    entity_id = _name_first(repository, occurrences[0], actor)
    identity, _ = _propose(repository, run_id)
    pending = identity.pending_proposal(occurrence_id=occurrences[1], entity_id=entity_id)
    assert pending is not None
    reject_link(
        identity,
        occurrence_id=occurrences[1],
        entity_id=entity_id,
        actor=actor,
        basis_digest=bytes(pending["basis_digest"]),
        basis_modalities=pending["basis"]["modalities"],
    )
    confirm_link(identity, occurrence_id=occurrences[1], entity_id=entity_id, actor=actor)

    live = repository.connection.execute(
        "select count(*) as n from identity_rejection where workspace_id = %s "
        "and revoked_at is null",
        (repository.workspace_id,),
    ).fetchone()
    assert live["n"] == 0, "a rejection survived the confirmation that contradicted it"


def test_the_open_question_count_falls_when_the_question_is_answered(corpus):
    """``open_question_count`` had to stop meaning "was ever surfaced".

    Counting ``outcome = 'surfaced'`` counts answered proposals forever, and the ambient counter
    the interface shows would read the same number for the rest of time.
    """
    from orimera.graph import read_snapshot

    repository, run_id, _captures, occurrences = corpus
    actor = uuid.uuid4()
    entity_id = _name_first(repository, occurrences[0], actor)
    identity, _ = _propose(repository, run_id)

    before = read_snapshot(repository.connection, repository.workspace_id)
    assert [e.open_question_count for e in before.entities] == [1]

    confirm_link(identity, occurrence_id=occurrences[1], entity_id=entity_id, actor=actor)
    after = read_snapshot(repository.connection, repository.workspace_id)
    assert [e.open_question_count for e in after.entities] == [0]


def test_no_proposal_is_written_when_nothing_corroborates(repository):
    """A label match with no context signal is not a weak question. It is not a question."""
    from orimera.evidence import EvidenceAddress
    from orimera.evidence.blob import BlobId
    from orimera.identity.keys import occurrence_identity_key
    from orimera.ingest.ledger import Ledger

    run = Ledger.start_run(repository, trigger="ingest")
    occurrences = []
    for index in range(2):
        blob = BlobId.of_bytes(f"lonely-{index}".encode())
        repository.upsert_blob(blob, byte_size=8, media_type="image/jpeg", storage_key=f"l{index}")
        capture = repository.insert_capture(blob, device_id="probe", started_at=None)
        address = EvidenceAddress.photograph(blob)
        span = repository.upsert_span(address)
        occurrences.append(
            repository.insert_occurrence(
                capture_id=capture.capture_id,
                occurrence_class="person",
                primary_span_id=span,
                span_ids=[span],
                presence=[(0, 1)],
                produced_by_run=run.run_id,
                detector_version="probe:1",
                identity_key=occurrence_identity_key(address, "person"),
                emit_key=f"lonely:o:{index}",
                quality={"label": "person"},
            )
        )
    # No scene group, no GPS, no shared labels: nothing corroborates.
    _name_first(repository, occurrences[0], uuid.uuid4())
    _identity, report = _propose(repository, run.run_id)
    assert report.written == 0
    assert report.uncorroborated == 1, report


def test_the_producer_never_writes_a_link(corpus):
    """It proposes and it does not decide. There is no auto-link branch and its absence is the
    strongest available statement that an uncalibrated number is not linking anybody.
    """
    repository, run_id, _captures, occurrences = corpus
    _name_first(repository, occurrences[0], uuid.uuid4())
    before = repository.connection.execute(
        "select count(*) as n from entity_link where workspace_id = %s",
        (repository.workspace_id,),
    ).fetchone()["n"]
    _propose(repository, run_id)
    after = repository.connection.execute(
        "select count(*) as n from entity_link where workspace_id = %s",
        (repository.workspace_id,),
    ).fetchone()["n"]
    assert after == before


def test_the_surface_threshold_is_a_parameter_and_not_a_constant():
    """The weights are unvalidated, and an edit has to move the digest that records them.

    Same discipline as the depth stage: parameters rather than constants, so a later tuning pass
    is recorded on the rows it produced rather than applied retroactively.
    """
    from orimera.identity.proposer import params_digest

    original = params_digest()
    PROPOSER_PARAMS["surface_threshold_milli"] = 999
    try:
        assert params_digest() != original
    finally:
        PROPOSER_PARAMS["surface_threshold_milli"] = 300
    assert params_digest() == original

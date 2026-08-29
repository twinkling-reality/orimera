"""``predicate.functional`` enforced, against a real PostgreSQL server.

Defect R16: 0001 declared ``functional boolean not null default false, -- at most one active
object per subject`` and nothing read the column. That is the same shape as R1 and R4, a property
written where enforcement would go and held up by nobody, and it meant a capture could carry two
current rungs and an entity two current names with no rule about which was shown.

Migration 0006 makes it real by superseding rather than refusing, because 0002 already decided
that: "History is corrected by writing a new row that supersedes this one, or by a retraction,
both of which leave the original readable."

The test that matters most here is
``test_a_re_run_of_an_identical_claim_does_not_retire_the_one_it_would_replace``. The obvious
implementation of this feature blanks the library on the second ingest pass, and it does so
silently.
"""

from __future__ import annotations

import uuid

import psycopg
import pytest


def _claim(
    repository,
    *,
    predicate_key: str,
    subject: dict,
    value: str,
    emit_key: str,
    user: uuid.UUID,
) -> uuid.UUID | None:
    return repository.insert_assertion(
        kind="user",
        predicate_key=predicate_key,
        subject_ref=subject,
        object_value=value,
        emit_key=emit_key,
        support_span_ids=[],
        stated_by_user=user,
    )


def _rows(repository, predicate_key: str) -> list[tuple[str, str]]:
    return [
        (row["v"], row["status"])
        for row in repository.connection.execute(
            "select a.object_value #>> '{}' as v, a.status from assertion a "
            "join predicate p on p.predicate_id = a.predicate_id "
            "where a.workspace_id = %s and p.key = %s "
            "order by a.asserted_at, a.assertion_id",
            (repository.workspace_id, predicate_key),
        ).fetchall()
    ]


@pytest.fixture
def subject() -> dict:
    return {"type": "capture", "id": str(uuid.uuid4())}


def test_a_second_active_claim_supersedes_the_first(repository, subject):
    """One current claim per subject, which is what the column said all along."""
    user = uuid.uuid4()
    _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the courtyard",
        emit_key="k1",
        user=user,
    )
    _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the terrace",
        emit_key="k2",
        user=user,
    )

    assert _rows(repository, "place_is") == [
        ("the courtyard", "superseded"),
        ("the terrace", "active"),
    ]


def test_the_superseded_claim_is_named_by_the_one_that_replaced_it(repository, subject):
    """A retired claim is readable and the chain says what retired it.

    Without this the history is a set of rows with statuses and no order of events, which is the
    thing the bitemporal columns exist to avoid.
    """
    user = uuid.uuid4()
    first = _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the courtyard",
        emit_key="k1",
        user=user,
    )
    second = _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the terrace",
        emit_key="k2",
        user=user,
    )
    supersedes = repository.connection.execute(
        "select supersedes from assertion where assertion_id = %s", (second,)
    ).fetchone()["supersedes"]
    assert supersedes == first


def test_a_re_run_of_an_identical_claim_does_not_retire_the_one_it_would_replace(
    repository, subject
):
    """The failure the obvious implementation has, and the reason this file exists.

    ``AssertionWriter.insert`` writes ``on conflict (workspace_id, emit_key) do nothing``, and a
    BEFORE INSERT row trigger fires BEFORE that conflict is detected. A trigger that retires the
    previous active row therefore retires it for an insert that is then skipped, and the subject
    is left with no current claim at all.

    Measured on a scratch database against the version without the emit_key guard:

        after first insert   [('the courtyard', 'active')]
        after a newer claim  [('the courtyard', 'superseded'), ('the terrace', 'active')]
        after a RE-RUN       [('the courtyard', 'superseded'), ('the terrace', 'superseded')]

    Re-running an ingest is free and is the normal thing to do, so that version would have
    blanked every ``captured_at``, ``gps_position_is``, ``place_is`` and name in the library on
    the second pass, quietly.
    """
    user = uuid.uuid4()
    _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the courtyard",
        emit_key="k1",
        user=user,
    )
    _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the terrace",
        emit_key="k2",
        user=user,
    )
    # Both emit keys again, exactly as a second ingest pass replays them.
    assert (
        _claim(
            repository,
            predicate_key="place_is",
            subject=subject,
            value="the courtyard",
            emit_key="k1",
            user=user,
        )
        is None
    )
    assert (
        _claim(
            repository,
            predicate_key="place_is",
            subject=subject,
            value="the terrace",
            emit_key="k2",
            user=user,
        )
        is None
    )

    rows = _rows(repository, "place_is")
    active = [row for row in rows if row[1] == "active"]
    assert active == [("the terrace", "active")], (
        f"a re-run left {len(active)} current claims instead of one: {rows}. A trigger that "
        "retires the previous row before ON CONFLICT skips the replacement blanks the subject."
    )


def test_a_non_functional_predicate_still_accepts_many_active_claims(repository, subject):
    """The other side of the rule. A photograph holds many objects and all of them are current."""
    user = uuid.uuid4()
    for index, label in enumerate(("red cube", "blue cube", "a bench")):
        _claim(
            repository,
            predicate_key="object_present",
            subject=subject,
            value=label,
            emit_key=f"o{index}",
            user=user,
        )
    assert [row[1] for row in _rows(repository, "object_present")] == ["active"] * 3


def test_two_subjects_do_not_supersede_each_other(repository):
    """Scoped by subject, not by predicate. Naming one place must not retire another's name."""
    user = uuid.uuid4()
    for index in range(2):
        _claim(
            repository,
            predicate_key="place_is",
            subject={"type": "capture", "id": str(uuid.uuid4())},
            value=f"place {index}",
            emit_key=f"s{index}",
            user=user,
        )
    assert [row[1] for row in _rows(repository, "place_is")] == ["active", "active"]


def test_the_index_refuses_a_second_current_claim_that_bypasses_the_trigger(repository, subject):
    """The trigger is the mechanism; this is what makes it a guarantee.

    Reactivating a superseded row beside a current one is an UPDATE, so no INSERT trigger sees
    it. Two concurrent inserts are the other route: neither transaction can see the other's
    retirement under READ COMMITTED, so both would insert. The index turns both into a loud
    refusal instead of a second current claim nobody notices.
    """
    user = uuid.uuid4()
    _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the courtyard",
        emit_key="k1",
        user=user,
    )
    _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the terrace",
        emit_key="k2",
        user=user,
    )
    with pytest.raises(psycopg.errors.UniqueViolation):
        repository.connection.execute(
            "update assertion set status = 'active' "
            "where workspace_id = %s and status = 'superseded'",
            (repository.workspace_id,),
        )


def test_the_mirrored_flag_may_not_be_rewritten_in_place(repository, subject):
    """Flipping it to false would lift a row out of the index and permit a second current claim.

    0002's tg_assertion_no_in_place_rewrite lists every column that may not change. The new
    column would not have been on that list, so 0006 redefines that function rather than adding a
    second trigger to answer the same question.
    """
    user = uuid.uuid4()
    written = _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the courtyard",
        emit_key="k1",
        user=user,
    )
    with pytest.raises(psycopg.errors.IntegrityError, match="predicate_is_functional"):
        repository.connection.execute(
            "update assertion set predicate_is_functional = false where assertion_id = %s",
            (written,),
        )


def test_the_mirror_matches_the_vocabulary_for_every_predicate(repository, subject):
    """The copy is only as good as the thing that maintains it, so the copy is checked.

    A predicate seeded functional whose assertions carry ``predicate_is_functional = false``
    would sit outside the index and be unconstrained, and nothing else would say so.
    """
    user = uuid.uuid4()
    _claim(
        repository,
        predicate_key="place_is",
        subject=subject,
        value="the courtyard",
        emit_key="f1",
        user=user,
    )
    _claim(
        repository,
        predicate_key="object_present",
        subject=subject,
        value="red cube",
        emit_key="f2",
        user=user,
    )
    mismatched = repository.connection.execute(
        "select p.key from assertion a join predicate p on p.predicate_id = a.predicate_id "
        "where a.workspace_id = %s and a.predicate_is_functional is distinct from p.functional",
        (repository.workspace_id,),
    ).fetchall()
    assert mismatched == [], f"the mirrored flag disagrees with the vocabulary: {mismatched}"

"""R20: a claim is a lease, and what happens to the worker whose lease was taken.

Every test here holds one half of a distinction the register said was not guessable, and each of
them was confirmed by reverting the change it covers and watching it go red.

The two halves are the whole point. A reclaim that fires on a dead claimant and NOT on a slow live
one is the feature; a reclaim that fires on both is the defect the register warned against, and
`claimed_at` alone produces exactly that. Measured with two real worker processes against a real
database: a worker eight four-second captures into a job under a ten second lease was called
stranded by a `claimed_at` predicate for 24 consecutive seconds and was never called stranded by
the lease.

The token gets two tests rather than one because it prevents two different writes: the claimed
job's terminal state, and the watched batch's terminal event. Measured with the token removed and
two real processes: the reclaiming worker wrote `succeeded` and the original wrote `failed` over
the same batch 4.5 seconds later, with a fresh `ended_at`, after the client's stream had already
ended on the first.
"""

from __future__ import annotations

import json
import uuid

import psycopg
import pytest
from orimera.api.authorisation import load_token_directory
from orimera.api.services import Services
from orimera.db.session import Database
from orimera.ingest import derivative_queue
from orimera.ingest.batch import IntakeBatch
from orimera.ingest.pipeline import PhotoIngestPipeline
from orimera.ingest.worker import MINIMUM_LEASE_SECONDS, DerivativeWorker, lease_seconds_for
from orimera.models.manifest import Role
from orimera.store.local import LocalContentAddressedStore

from conftest import CountingVisionModel, photo_bytes
from tests_support_api import scratch_database

#: Long enough that nothing in a test expires by accident, short enough to be pushed into the
#: past by hand. Every test that wants an expired lease writes one rather than waiting.
_LEASE = 300.0


class Queued:
    """One batch of intaken captures with a derivative job waiting on them."""

    def __init__(self, repository, store, database, batch_id, job_id, capture_ids) -> None:
        self.repository = repository
        self.store = store
        self.database = database
        self.batch_id = batch_id
        self.job_id = job_id
        self.capture_ids = capture_ids
        self.vision = CountingVisionModel()

    @property
    def connection(self):
        return self.repository.connection

    @property
    def workspace_id(self):
        return self.repository.workspace_id

    def rows(self, sql: str, *params):
        return self.connection.execute(sql, params).fetchall()

    def job(self) -> dict:
        return dict(
            self.rows(
                "select state, attempts, claimed_by, last_error, lease_expires_at, claim_token "
                "from job where job_id = %s",
                self.job_id,
            )[0]
        )

    def batch(self) -> dict:
        return dict(
            self.rows(
                "select status, ended_at from intake_batch where batch_id = %s", self.batch_id
            )[0]
        )

    def strand(self, *, attempts: int = 1) -> None:
        """Leave the row exactly as a worker that stopped saying anything leaves it."""
        self.connection.execute(
            "update job set state = 'running', claimed_by = 'gone', claimed_at = now(), "
            "  attempts = %s, claim_token = gen_random_uuid(), "
            "  lease_expires_at = now() - interval '1 second' "
            "where job_id = %s",
            (attempts, self.job_id),
        )

    def worker(self, **kwargs) -> DerivativeWorker:
        return DerivativeWorker(
            self.database,
            self.store,
            frozenset({self.workspace_id}),
            vision=self.vision,
            name=kwargs.pop("name", "test-worker"),
            lease_seconds=kwargs.pop("lease_seconds", _LEASE),
            **kwargs,
        )


@pytest.fixture
def queued(tmp_path, repository, spine_schema):
    _psycopg, scratch = spine_schema
    store = LocalContentAddressedStore(tmp_path / "blobs")
    pipeline = PhotoIngestPipeline(repository, store)
    batch = IntakeBatch.open(repository, label="upload")
    capture_ids = []
    for index in range(2):
        outcome = pipeline.ingest_intake(
            photo_bytes(when=f"2026:08:27 10:0{index}:00"),
            filename=f"p{index}.jpg",
            batch_id=batch.batch_id,
        )
        assert outcome.capture_id is not None, outcome.error
        capture_ids.append(outcome.capture_id)
    batch.declare_size(len(capture_ids))
    job_id = derivative_queue.enqueue(
        repository.connection,
        repository.workspace_id,
        batch_id=batch.batch_id,
        capture_ids=capture_ids,
    )
    return Queued(
        repository, store, scratch_database(scratch), batch.batch_id, job_id, capture_ids
    )


# -- the reclaim fires on a claimant that stopped saying anything ----------------------------


def test_a_stranded_running_row_is_claimed_again_and_says_it_was(queued):
    """The row a dead worker leaves is invisible to a `state = 'queued'` predicate, which is R20.

    ``attempts`` increments rather than resetting, so the row says it was claimed twice rather
    than looking like a job nobody has started. That number is what :func:`abandon` reads later.
    """
    queued.strand()
    assert queued.rows(
        "select job_id from job where workspace_id = %s and state = 'queued'", queued.workspace_id
    ) == [], "the row is not queued, which is the whole difficulty"

    claimed = derivative_queue.claim(
        queued.connection, queued.workspace_id, worker="second", lease_seconds=_LEASE
    )
    assert claimed is not None, "a worker that stopped saying anything strands its job for ever"
    assert claimed.job_id == queued.job_id
    assert claimed.attempts == 2
    row = queued.job()
    assert row["claimed_by"] == "second"
    assert row["lease_expires_at"] is not None
    assert row["claim_token"] == claimed.claim_token


def test_a_claimant_that_keeps_beating_is_not_reclaimed_and_claimed_at_alone_would_have(queued):
    """The half a `claimed_at` reclaim gets wrong, in one test beside the half it gets right.

    A job legitimately inside a slow model call has an old ``claimed_at`` and a live lease, and
    the two predicates disagree about it. Reclaiming it is not merely wasteful: it is a second
    paid model call over the same captures, and it puts two workers on one batch.
    """
    first = derivative_queue.claim(
        queued.connection, queued.workspace_id, worker="first", lease_seconds=_LEASE
    )
    assert first is not None
    # Old enough that a claimed_at reclaim with any sane cooldown would take it.
    queued.connection.execute(
        "update job set claimed_at = now() - interval '1 hour' where job_id = %s", (queued.job_id,)
    )
    assert derivative_queue.heartbeat(
        queued.connection,
        queued.workspace_id,
        job_id=queued.job_id,
        claim_token=first.claim_token,
        lease_seconds=_LEASE,
    )

    assert (
        derivative_queue.claim(
            queued.connection, queued.workspace_id, worker="second", lease_seconds=_LEASE
        )
        is None
    ), "a worker inside a slow model call was reclaimed while it was working"

    would_have = queued.rows(
        "select count(*) as n from job where workspace_id = %s and state = 'running' "
        "  and claimed_at < now() - make_interval(secs => %s)",
        queued.workspace_id,
        _LEASE,
    )[0]["n"]
    assert would_have == 1, (
        "the claimed_at predicate has to say STRANDED here, or this test is not holding the "
        "distinction it claims to hold"
    )


# -- the token, which is what makes a wrong lease cheap ---------------------------------------


def test_a_worker_that_lost_its_lease_is_told_so_rather_than_racing(queued):
    first = derivative_queue.claim(
        queued.connection, queued.workspace_id, worker="first", lease_seconds=_LEASE
    )
    assert first is not None
    queued.connection.execute(
        "update job set lease_expires_at = now() - interval '1 second' where job_id = %s",
        (queued.job_id,),
    )
    second = derivative_queue.claim(
        queued.connection, queued.workspace_id, worker="second", lease_seconds=_LEASE
    )
    assert second is not None
    assert second.claim_token != first.claim_token

    assert not derivative_queue.heartbeat(
        queued.connection,
        queued.workspace_id,
        job_id=queued.job_id,
        claim_token=first.claim_token,
        lease_seconds=_LEASE,
    )
    assert not derivative_queue.finish(
        queued.connection,
        queued.workspace_id,
        job_id=queued.job_id,
        state="failed",
        claim_token=first.claim_token,
        error="the worker that no longer holds this job",
    )
    row = queued.job()
    assert row["state"] == "running", "the reclaimed job was closed by the worker that lost it"
    assert row["last_error"] is None

    assert derivative_queue.finish(
        queued.connection,
        queued.workspace_id,
        job_id=queued.job_id,
        state="done",
        claim_token=second.claim_token,
    )
    assert queued.job()["state"] == "done"


def test_the_worker_whose_lease_was_taken_neither_finishes_the_job_nor_closes_the_batch(queued):
    """The whole reclaim, driven through the worker, with the harm the token prevents named.

    Measured with two real processes and the token removed: `succeeded` at 17:58:13.896531 from
    the reclaiming worker and `failed` at 17:58:18.428698 from the original, over one batch, the
    second arriving after the subscriber's stream had ended on the first.
    """
    first = derivative_queue.claim(
        queued.connection, queued.workspace_id, worker="first", lease_seconds=_LEASE
    )
    assert first is not None
    queued.connection.execute(
        "update job set lease_expires_at = now() - interval '1 second' where job_id = %s",
        (queued.job_id,),
    )

    outcomes = queued.worker(name="second").drain()
    assert [outcome.succeeded for outcome in outcomes] == [2]
    assert queued.batch()["status"] == "succeeded"
    ended_at = queued.batch()["ended_at"]

    # And now the first worker, still holding a claim it lost, tries to close what it was doing.
    assert not derivative_queue.finish(
        queued.connection,
        queued.workspace_id,
        job_id=queued.job_id,
        state="failed",
        claim_token=first.claim_token,
        error="the endpoint went away",
    ), "the worker that lost its lease closed the job the reclaiming worker had already closed"
    assert queued.job()["state"] == "done"
    assert queued.batch() == {"status": "succeeded", "ended_at": ended_at}, (
        "one batch, one terminal event"
    )


class _StealsTheLease:
    """A vision model that has the job reclaimed out from under its own worker, mid-job.

    The only honest way to test the beat in one process: the reclaim has to happen while the
    worker is inside a capture, and a vision call is where a worker spends its time.
    """

    model_id = "MiniMaxAI/MiniMax-M3"

    def __init__(self, queued: Queued) -> None:
        self._queued = queued
        self.calls = 0
        self.thief: derivative_queue.QueuedDerivatives | None = None

    def observe(self, *, image_bytes: bytes, media_type: str):
        self.calls += 1
        if self.thief is None:
            self._queued.connection.execute(
                "update job set lease_expires_at = now() - interval '1 second' where job_id = %s",
                (self._queued.job_id,),
            )
            self.thief = derivative_queue.claim(
                self._queued.connection,
                self._queued.workspace_id,
                worker="thief",
                lease_seconds=_LEASE,
            )
            assert self.thief is not None
        return CountingVisionModel().observe(image_bytes=image_bytes, media_type=media_type)


def test_a_worker_reclaimed_mid_job_stops_working_rather_than_finishing_it(queued):
    """The beat is what turns a lost lease into a stop, and a stop is what bounds the waste.

    Without it the worker runs every remaining capture for a job somebody else is already
    running, which for a configured instance is a paid model call per photograph, and only then
    discovers at ``finish`` that it never owned the row.
    """
    stealing = _StealsTheLease(queued)
    worker = DerivativeWorker(
        queued.database,
        queued.store,
        frozenset({queued.workspace_id}),
        vision=stealing,
        name="first",
        lease_seconds=_LEASE,
    )
    outcomes = worker.drain()

    assert len(outcomes) == 1
    assert outcomes[0].lease_lost is True
    assert stealing.calls == 1, (
        f"the worker computed {stealing.calls} captures for a job it had already lost"
    )
    assert queued.job()["claimed_by"] == "thief"
    assert queued.job()["state"] == "running", "the worker closed a job it no longer held"
    assert queued.batch()["status"] == "running", "the worker closed a batch it no longer held"


def test_a_closed_batch_is_not_reopened(queued):
    """The second guard, which holds for any caller rather than only one holding a lease."""
    batch = IntakeBatch(repository=queued.repository, batch_id=queued.batch_id)
    assert batch.close("succeeded")
    first = queued.batch()
    assert not batch.close("failed")
    assert queued.batch() == first


# -- the index the reclaim arm needs ----------------------------------------------------------


def test_the_reclaim_arm_is_served_by_an_index_that_can_see_running(queued):
    """`job_queue_idx` is partial on `state = 'queued'` and cannot serve this query at all.

    Asserted through EXPLAIN rather than through a timing, because a timing over two rows is
    noise. The second half is what makes the first half mean something: with the index dropped
    inside this test's transaction, the same plan falls back to a sequential scan even with
    `enable_seqscan` off, which is the pre-0016 shape.
    """
    queued.strand()

    def plan() -> str:
        rows = queued.rows(
            "explain select job_id from job "
            " where workspace_id = %s and kind = %s and state = 'running' "
            "   and lease_expires_at < now() and attempts < %s "
            " order by priority, job_id limit 1",
            queued.workspace_id,
            derivative_queue.DERIVATIVES,
            derivative_queue.MAX_CLAIMS,
        )
        return "\n".join(str(next(iter(row.values()))) for row in rows)

    queued.connection.execute("set enable_seqscan = off")
    try:
        with_index = plan()
        assert "job_reclaim_idx" in with_index, with_index
        without_index = ""
        with queued.connection.transaction():
            queued.connection.execute("drop index job_reclaim_idx")
            without_index = plan()
            # Rolled back rather than recreated: the index belongs to the migration, and a test
            # that rebuilt it by hand would be asserting against its own definition.
            raise psycopg.Rollback
    finally:
        queued.connection.execute("set enable_seqscan = on")
    assert "Seq Scan on job" in without_index, without_index


def test_a_running_job_without_a_lease_is_refused_by_the_schema(queued):
    """A claim that wrote no lease would be a row nothing could ever reclaim, silently."""
    with pytest.raises(psycopg.errors.CheckViolation, match="a_running_job_holds_a_lease"):
        queued.connection.execute(
            "update job set state = 'running', claim_token = gen_random_uuid() where job_id = %s",
            (queued.job_id,),
        )
    with pytest.raises(psycopg.errors.CheckViolation, match="a_running_job_holds_a_lease"):
        queued.connection.execute(
            "update job set state = 'running', lease_expires_at = now() + interval '1 minute' "
            "where job_id = %s",
            (queued.job_id,),
        )


# -- the bound, and what happens at it --------------------------------------------------------


def test_a_job_stranded_too_often_is_abandoned_and_its_batch_closed(queued):
    """The bound has to have a terminal move or it is a leak with a limit on it.

    A job at :data:`MAX_CLAIMS` sits in `running` where `job_one_live_job_per_batch` refuses any
    other job for that batch, so without this the batch never gets a terminal event, which is
    the original R20 symptom arriving by a new route.
    """
    queued.strand(attempts=derivative_queue.MAX_CLAIMS)
    assert (
        derivative_queue.claim(
            queued.connection, queued.workspace_id, worker="second", lease_seconds=_LEASE
        )
        is None
    ), "a job past its claim bound was claimed again"

    outcomes = queued.worker(name="second").drain()
    assert [outcome.abandoned for outcome in outcomes] == [True]
    assert outcomes[0].job_id == queued.job_id
    assert queued.vision.calls == 0, "an abandoned job must not be run"

    row = queued.job()
    assert row["state"] == "failed"
    assert row["lease_expires_at"] is None and row["claim_token"] is None
    assert f"claimed {derivative_queue.MAX_CLAIMS} times" in row["last_error"]
    assert queued.batch()["status"] == "failed"
    assert queued.batch()["ended_at"] is not None, (
        "the batch is still open, so its stream never ends"
    )


def test_a_live_job_at_the_bound_is_not_abandoned(queued):
    """`abandon` asks about the lease as well as the count, or it kills a working claimant."""
    queued.strand(attempts=derivative_queue.MAX_CLAIMS)
    queued.connection.execute(
        "update job set lease_expires_at = now() + interval '1 hour' where job_id = %s",
        (queued.job_id,),
    )
    assert derivative_queue.abandon(queued.connection, queued.workspace_id) is None
    assert queued.job()["state"] == "running"


# -- where the lease comes from ---------------------------------------------------------------


def _services(tmp_path, monkeypatch, model_client):
    monkeypatch.setenv(
        "ORIMERA_API_TOKENS",
        json.dumps({"a-token-long-enough-to-be-accepted-here": {
            "workspace_id": str(uuid.uuid4()), "actor": str(uuid.uuid4())}}),
    )
    return Services(
        database=Database(url="postgresql://localhost:5433/never-connected-to"),
        readonly_database=Database(url="postgresql://localhost:5433/never-connected-to"),
        store=LocalContentAddressedStore(tmp_path / "blobs"),
        tokens=load_token_directory(),
        executor_shares_the_write_role=True,
        model_client=model_client,
        runs_derivative_worker=True,
    )


def test_the_lease_the_api_gives_its_worker_covers_the_vision_budget(tmp_path, client, monkeypatch):
    """Computed from the client the worker was given, so raising its timeout raises the lease.

    A constant here would be right for the API's client, whose `max_attempts` is 1, and wrong for
    `orimera-ingest`, whose is 3, on the day somebody changed either.
    """
    worker = _services(tmp_path, monkeypatch, client).build_derivative_worker()
    assert worker is not None
    budget = client.worst_case_seconds(Role.VISION)
    assert budget > 0
    assert worker._lease_seconds >= budget, (
        "the lease is shorter than one model call, so a live worker is reclaimed on every "
        "photograph"
    )
    assert worker._lease_seconds == lease_seconds_for(budget)


def test_a_worker_with_no_vision_model_gets_the_stated_floor(tmp_path, monkeypatch):
    """The deployment `Services.warnings` describes as ordinary, given a number rather than luck.

    With no credential the worker is built with `vision=None`, so there is no model budget to
    compute a lease from. The floor is what the lease is then, and it is stated rather than
    arrived at: measured with no vision model over a 200-photograph corpus, the largest gap
    between two beats was 0.033 seconds.
    """
    worker = _services(tmp_path, monkeypatch, None).build_derivative_worker()
    assert worker is not None
    assert worker._vision is None
    assert worker._lease_seconds == MINIMUM_LEASE_SECONDS
    assert lease_seconds_for(None) == MINIMUM_LEASE_SECONDS


def test_the_vision_budget_is_the_chain_the_timeout_and_the_retries(client, manifest):
    """The arithmetic `walk` actually performs, not a number typed beside it."""
    chain = len(manifest[Role.VISION].chain)
    assert chain == 2
    assert client.worst_case_seconds(Role.VISION) == pytest.approx(chain * 180.0)

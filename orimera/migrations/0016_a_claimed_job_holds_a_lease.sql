-- 0016_a_claimed_job_holds_a_lease.sql
-- R20. A dead worker's `running` row is reclaimable, and a live worker's is not.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT 0012 SAID AND WHY THIS IS NOT A CONTRADICTION OF IT.
--
-- 0012's header says a reclaim of a dead worker's `running` row is deliberately absent, because
-- the claim query filters `state = 'queued'` and `job_queue_idx` is partial on the same, so
-- nothing could see a stranded row and a reclaim written against that shape would not work. That
-- was true of that shape and it is still true of it. This file changes the shape: it adds the
-- heartbeat column 0012 said a real reclaim needs, an index that can see `running`, and the one
-- thing 0012 did not name, which measurement showed is what makes the difference between a
-- recovery and a corruption.
--
-- THE COLUMN 0012 DID NOT NAME: `claim_token`. A lease alone is not enough, because a lease is a
-- guess about how long a claimant may be silent, and a wrong guess reclaims a job that is still
-- being worked on. Measured on this schema with two real worker processes, a three second lease
-- and nine second captures, with the token check removed:
--
--     17:58:13.896531  worker B closed the batch and wrote intake_batch.status = 'succeeded'
--     17:58:18.428698  worker A closed the SAME batch as 'failed', with a fresh ended_at
--
-- Two terminal events 4.5 seconds apart, the second contradicting the first, after the
-- subscriber's formation stream had already ended on the first. The job row went from done back
-- to failed in the same pass. With the token, on the same fixture, A's next heartbeat matched no
-- row, A withdrew without finishing the job and without closing the batch, and the batch kept one
-- terminal event. The token is what bounds a wrong lease to one duplicated vision call instead of
-- two terminal events, and it is why this is safe to ship with a lease that is a heuristic.
--
-- WHY NOT `claimed_at` ALONE, which is what `purge_job` uses. Measured on this schema: worker A
-- ran eight four-second captures under a ten second lease, beating between them, for 33 seconds.
-- A watcher sampling both predicates every two seconds recorded, for 24 consecutive seconds,
-- lease_says_stranded = 0 and claimed_at_alone_says_stranded = 1, while a second real worker
-- polling the real claim 38 times beside it claimed nothing. A job legitimately inside a
-- slow model call is indistinguishable from a dead one by `claimed_at`, and every reclaim it
-- produces is a paid model call charged twice. `purge_job` can use it because every step of a
-- purge is idempotent and free; a derivative job's expensive step is a model call with a
-- per-request nonce and `use_cache=False`, so nothing absorbs a duplicate.
--
-- STOP THE WORKERS BEFORE APPLYING THIS. The backfill below gives every row already in `running`
-- one lease of grace, which is enough for a worker mid-job to finish, and it is grace rather
-- than a guarantee: a pre-0016 worker still running when its grace expires has its job reclaimed
-- and holds no token to lose, so it will close the batch anyway. There is no rolling-deploy path
-- for this file: stop every process that drains `job`, apply this, start them again. That order is
-- stated here rather than in a runbook because this file is what an operator is looking at when
-- they need it.
-- ---------------------------------------------------------------------------------------------

begin;

select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. The two columns a claim now holds.
-- --------------------------------------------------------------------------------------------

alter table job add column lease_expires_at timestamptz;
alter table job add column claim_token uuid;

comment on column job.lease_expires_at is
  'When this claimant stops being believed. Pushed forward by a heartbeat between captures and '
  'null in every state but running. NOT claimed_at: a job inside a slow model call is '
  'indistinguishable from a dead one by when it was claimed, and reclaiming it pays for the '
  'model call twice.';

comment on column job.claim_token is
  'Rotated by every claim, carried by the claimant, and checked by every write the claimant '
  'makes to this row. It is what a worker whose lease was taken discovers instead of racing: '
  'without it, measured, two terminal events were written for one batch 4.5 seconds apart, the '
  'second contradicting the first and arriving after the client stream had ended.';

-- --------------------------------------------------------------------------------------------
-- 2. A running row holds both, so an unleased claim is a schema error rather than a job nothing
--    can ever reclaim. Written as an implication so the terminal states stay unconstrained:
--    `finish` clears both, and a done row holding a stale token would be a second opinion about
--    who owns work that is over.
-- --------------------------------------------------------------------------------------------

update job
   set lease_expires_at = now() + interval '15 minutes',
       claim_token = gen_random_uuid()
 where state = 'running'
   and (lease_expires_at is null or claim_token is null);

alter table job add constraint a_running_job_holds_a_lease
  check (state <> 'running' or (lease_expires_at is not null and claim_token is not null));

-- --------------------------------------------------------------------------------------------
-- 3. The index the reclaim arm needs.
--
-- `job_queue_idx` is partial on `state = 'queued'` and cannot serve a query about `running` rows
-- at all: measured with enable_seqscan off and only the pre-0016 indexes present, the reclaim
-- arm still planned a sequential scan, marked `Disabled: true`. This one is partial on the state
-- the arm asks about and leads on the columns it filters by.
-- --------------------------------------------------------------------------------------------

create index job_reclaim_idx
  on job (workspace_id, kind, lease_expires_at)
  where state = 'running';

commit;

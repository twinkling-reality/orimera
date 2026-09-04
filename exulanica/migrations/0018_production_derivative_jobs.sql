-- 0018_production_derivative_jobs.sql
-- Durable delivery observability for the derivative queue, and reviewed stage definitions.
--
-- The pipeline ledger and the delivery ledger answer different questions. `pipeline_event`
-- records what happened to evidence and artifacts. `derivative_job_event` records how that work
-- was delivered: claims, lease renewals, retries, reclaims, cancellation, lease loss and the one
-- terminal outcome. Folding those into invented pipeline stages would make a worker heartbeat
-- look like evidence processing, so they stay separate and are joined by the batch and capture.
--
-- Target: PostgreSQL 18. Forward-only. Stop derivative workers before applying: this changes the
-- checked terminal vocabulary and adds the ledger written by every queue transition.

begin;

select pg_advisory_xact_lock(119622309);

-- A run can now say why a real stage did not produce an artifact. These are facts, not aliases:
-- reused means an immutable output already satisfied the stage; unavailable means its required
-- implementation was not configured; missing means an input that should have existed did not;
-- skipped is reserved for a reviewed stage deliberately disabled by policy.
alter type pipeline_event_type add value if not exists 'stage_skipped';
alter type pipeline_event_type add value if not exists 'stage_unavailable';
alter type pipeline_event_type add value if not exists 'stage_missing';

-- `stage_registry` is the current pointer and therefore overwrites a previous version. A replay
-- needs the definition that was active when its event was written, so definitions are additive.
-- Multiple parameter digests may share a semantic stage version: vision includes the prompt
-- digest in its parameters specifically so an edited prompt reprocesses even if a human forgets
-- to bump a version integer.
create table stage_definition (
  stage_key       text not null,
  stage_version   int not null check (stage_version > 0),
  params_digest   bytea not null check (octet_length(params_digest) = 32),
  params           jsonb,
  model_role       text,
  deterministic   boolean,
  output_kind      text,
  review_status    text not null check (review_status in ('reviewed','historical')),
  registered_at    timestamptz not null default now(),
  primary key (stage_key, stage_version, params_digest)
);

-- Existing events are already historical facts. Their exact digest is known; metadata that the
-- old current-pointer table no longer retains stays NULL rather than being reconstructed from
-- today's source and presented as historical truth.
insert into stage_definition (
  stage_key, stage_version, params_digest, params, model_role, deterministic, output_kind,
  review_status
)
select distinct pe.stage_key, pe.stage_version, pe.params_digest,
       case when sr.current_version = pe.stage_version then sr.params_schema else null end,
       case when sr.current_version = pe.stage_version then sr.model_ref ->> 'role' else null end,
       case when sr.current_version = pe.stage_version then sr.deterministic else null end,
       case when sr.current_version = pe.stage_version then sr.output_kind else null end,
       'historical'
  from pipeline_event pe
  left join stage_registry sr on sr.stage_key = pe.stage_key
 where pe.stage_key is not null
   and pe.stage_version is not null
   and pe.params_digest is not null
on conflict do nothing;

create or replace function tg_pipeline_event_uses_registered_stage() returns trigger
language plpgsql as $fn$
begin
  if new.stage_key is null then
    if new.stage_version is not null then
      raise exception 'a stage-less pipeline event cannot name stage version %', new.stage_version;
    end if;
    return new;
  end if;

  if new.stage_version is null or new.params_digest is null then
    raise exception 'pipeline event stage % needs a version and parameter digest', new.stage_key;
  end if;

  if not exists (
    select 1 from stage_definition d
     where d.stage_key = new.stage_key
       and d.stage_version = new.stage_version
       and d.params_digest = new.params_digest
  ) then
    raise exception 'pipeline stage % version % with parameters % is not registered',
      new.stage_key, new.stage_version, encode(new.params_digest, 'hex');
  end if;
  return new;
end $fn$;

create trigger tg_pipeline_event_registered_stage
  before insert on pipeline_event
  for each row execute function tg_pipeline_event_uses_registered_stage();

-- Derivative runs name the delivery claim that opened them. On reclaim the new claimant closes
-- any run left open by the expired token, which makes process death a replayable failure rather
-- than a `running` row that survives forever.
-- `job_id` leads this redundant composite identity deliberately. Leading with workspace_id made
-- the planner prefer this broad uniqueness index over the measured partial reclaim index on a
-- small queue. The global job primary key still makes the pair unique; the pair exists only so a
-- composite foreign key can prove the tenant boundary.
alter table job add constraint job_workspace_identity unique (job_id, workspace_id);
alter table pipeline_run add column delivery_job_id uuid;
alter table pipeline_run add column delivery_claim_token uuid;
alter table pipeline_run add constraint pipeline_run_delivery_job_in_workspace
  foreign key (delivery_job_id, workspace_id) references job(job_id, workspace_id);
create index pipeline_run_delivery_idx
  on pipeline_run (workspace_id, delivery_job_id, delivery_claim_token)
  where delivery_job_id is not null;

create or replace function tg_pipeline_event_requires_open_run() returns trigger
language plpgsql as $fn$
begin
  perform 1 from pipeline_run r
   where r.run_id = new.run_id and r.status = 'running'
   for key share;
  if not found then
    raise exception 'pipeline run % is already terminal; refusing event %', new.run_id, new.type;
  end if;
  return new;
end $fn$;

create trigger tg_pipeline_event_open_run
  before insert on pipeline_event
  for each row execute function tg_pipeline_event_requires_open_run();

-- Missing and unavailable are terminal delivery outcomes, not generic failures. They are kept
-- distinct so an operator does not retry an absent capture or a model that was never configured.
alter table job drop constraint job_state_check;
alter table job add constraint job_state_check
  check (state in ('queued','running','done','failed','cancelled','missing','unavailable'));

alter table job add column completed_at timestamptz;
alter table job add column duration_ms bigint check (duration_ms is null or duration_ms >= 0);
alter table job add column failure_class text;
alter table job add column cost jsonb;
alter table job add column progress_completed int not null default 0
  check (progress_completed >= 0);
alter table job add column progress_total int check (progress_total is null or progress_total >= 0);

update job
   set completed_at = coalesce(claimed_at, created_at),
       duration_ms = greatest(
         0,
         (extract(epoch from (coalesce(claimed_at, created_at) - created_at)) * 1000)::bigint
       )
 where state in ('done','failed','cancelled');

alter table job add constraint a_terminal_job_has_a_completion_time
  check (
    (state in ('done','failed','cancelled','missing','unavailable') and completed_at is not null)
    or
    (state in ('queued','running') and completed_at is null)
  );

comment on column job.duration_ms is
  'End-to-end queue duration from enqueue to the one terminal transition. Per-stage execution '
  'duration remains on pipeline_event and is never inferred from this aggregate.';

create table derivative_job_event (
  event_id       uuid primary key default uuidv7(),
  workspace_id   uuid not null,
  job_id          uuid,
  worker_id       text not null,
  event_type      text not null check (event_type in (
    'worker_started','shutdown_requested','worker_stopped','claim_acquired','claim_reclaimed',
    'lease_renewed','retry_scheduled','capture_started','capture_succeeded','capture_failed',
    'capture_cancelled','capture_missing','capture_unavailable','lease_lost','job_succeeded',
    'job_failed','job_cancelled','job_missing','job_unavailable'
  )),
  claim_token     uuid,
  attempt         int check (attempt is null or attempt > 0),
  capture_id      uuid,
  progress_completed int check (progress_completed is null or progress_completed >= 0),
  progress_total  int check (progress_total is null or progress_total >= 0),
  duration_ms     bigint check (duration_ms is null or duration_ms >= 0),
  cost            jsonb,
  failure_class   text,
  message         text,
  occurred_at     timestamptz not null default now()
);

alter table derivative_job_event add constraint derivative_event_job_in_workspace
  foreign key (job_id, workspace_id) references job(job_id, workspace_id);

alter table derivative_job_event enable row level security;
alter table derivative_job_event force row level security;
create policy ws_isolation on derivative_job_event
  using (workspace_id = current_workspace())
  with check (workspace_id = current_workspace());

create index derivative_job_event_workspace_time_idx
  on derivative_job_event (workspace_id, occurred_at desc, event_id desc);
create index derivative_job_event_job_idx
  on derivative_job_event (workspace_id, job_id, occurred_at, event_id)
  where job_id is not null;

-- A claim token may produce many progress events, but a job has one terminal delivery fact.
-- The guarded update on `job` is the first line of defence; this is the invariant underneath it.
create unique index derivative_job_one_terminal_event
  on derivative_job_event (job_id)
  where event_type in (
    'job_succeeded','job_failed','job_cancelled','job_missing','job_unavailable'
  );

commit;

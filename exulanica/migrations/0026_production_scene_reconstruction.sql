-- 0026_production_scene_reconstruction.sql
-- A restart-safe job boundary for producing reconstruction scenes from explicit capture sets.
--
-- The completed scene remains the append-only subject migration 0024 created. A job is different:
-- it is mutable operational state that exists before registration is known. Its membership is
-- immutable, so retrying cannot silently change the question, while its lease and status may
-- advance. Sensitive COLMAP files live outside this table under scratch_key. Durable pose,
-- placement and gate receipts live in artifact and survive scratch cleanup.

begin;

select pg_advisory_xact_lock(119622309);

create table reconstruction_scene_job (
  job_id                   uuid primary key,
  workspace_id             uuid not null,
  scene_id                 uuid not null,
  member_digest            bytea not null check (octet_length(member_digest) = 32),
  selection_policy         jsonb not null,
  selection_policy_digest  bytea not null check (octet_length(selection_policy_digest) = 32),
  status                   text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts                 int not null default 0 check (attempts >= 0),
  available_at             timestamptz not null default now(),
  claim_token              uuid,
  claimed_by               text,
  lease_expires_at         timestamptz,
  scratch_key              text,
  pose_manifest_digest     bytea check (
    pose_manifest_digest is null or octet_length(pose_manifest_digest) = 32),
  pose_receipt_artifact_id uuid,
  placement_artifact_id    uuid,
  gate_artifact_id         uuid,
  failure_class            text,
  failure_message          text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz,
  unique (workspace_id, job_id),
  unique (workspace_id, scene_id, selection_policy_digest),
  check ((claim_token is null) = (claimed_by is null)),
  check ((claim_token is null) = (lease_expires_at is null))
);

create table reconstruction_scene_job_member (
  workspace_id uuid not null,
  job_id       uuid not null,
  capture_id   uuid not null,
  ordinal      int not null check (ordinal >= 0),
  primary key (workspace_id, job_id, capture_id),
  unique (workspace_id, job_id, ordinal),
  foreign key (workspace_id, job_id)
    references reconstruction_scene_job(workspace_id, job_id),
  foreign key (workspace_id, capture_id)
    references capture(workspace_id, capture_id)
);

create index reconstruction_scene_job_claim_idx
  on reconstruction_scene_job (workspace_id, available_at, created_at, job_id)
  where status in ('queued', 'failed');

create index reconstruction_scene_job_member_capture_idx
  on reconstruction_scene_job_member (workspace_id, capture_id, job_id);

create or replace function tombstone_blocks_reconstruction_job(p_workspace uuid, p_job uuid)
returns boolean
language sql volatile as $fn$
  select
    not exists (select 1 from reconstruction_scene_job_member m
                 where m.workspace_id = p_workspace and m.job_id = p_job)
    or exists (
      select 1
        from reconstruction_scene_job_member m
        join capture c on c.workspace_id = m.workspace_id and c.capture_id = m.capture_id
       where m.workspace_id = p_workspace
         and m.job_id = p_job
         and (c.deleted_at is not null
              or tombstone_blocks_capture(p_workspace, m.capture_id)));
$fn$;

comment on function tombstone_blocks_reconstruction_job(uuid, uuid) is
  'Does deletion reach any member of this exact pending capture set. Empty membership fails '
  'closed, as tombstone_blocks_scene does for a completed set.';

create function tg_reconstruction_job_member_live() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if not exists (select 1 from capture c
                  where c.workspace_id = new.workspace_id
                    and c.capture_id = new.capture_id
                    and c.deleted_at is null) then
    raise exception 'a reconstruction job member names an absent or deleted photograph'
      using errcode = 'foreign_key_violation';
  end if;
  if tombstone_blocks_capture(new.workspace_id, new.capture_id) then
    perform tombstone_refuse('reconstruction_scene_job_member');
  end if;
  return new;
end $fn$;

create trigger tg_guard_reconstruction_scene_job_member
  before insert on reconstruction_scene_job_member
  for each row execute function tg_reconstruction_job_member_live();

create function tg_reconstruction_job_member_append_only() returns trigger
language plpgsql as $fn$
begin
  raise exception 'reconstruction_scene_job_member is append-only'
    using errcode = 'integrity_constraint_violation';
end $fn$;

create trigger tg_reconstruction_scene_job_member_append_only
  before update or delete on reconstruction_scene_job_member
  for each row execute function tg_reconstruction_job_member_append_only();

create function tg_tombstone_cancels_reconstruction_jobs() returns trigger
language plpgsql as $fn$
begin
  if new.scope not in ('capture', 'workspace') then
    return new;
  end if;
  update reconstruction_scene_job j
     set status = 'cancelled',
         claim_token = null,
         claimed_by = null,
         lease_expires_at = null,
         completed_at = coalesce(j.completed_at, new.effective_at),
         updated_at = now(),
         failure_class = 'tombstoned',
         failure_message = 'a member was deleted before reconstruction completed'
   where j.workspace_id = new.workspace_id
     and j.status in ('queued', 'running', 'failed')
     and (new.scope = 'workspace'
          or exists (select 1 from reconstruction_scene_job_member m
                      where m.workspace_id = new.workspace_id
                        and m.job_id = j.job_id
                        and m.capture_id = new.capture_id));
  return new;
end $fn$;

create trigger tg_tombstone_cancels_reconstruction_jobs
  after insert on tombstone
  for each row execute function tg_tombstone_cancels_reconstruction_jobs();

do $$
declare
  t text;
begin
  foreach t in array array['reconstruction_scene_job', 'reconstruction_scene_job_member'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy ws_isolation on %I using (workspace_id = current_workspace()) '
      'with check (workspace_id = current_workspace())', t);
  end loop;
end $$;

commit;

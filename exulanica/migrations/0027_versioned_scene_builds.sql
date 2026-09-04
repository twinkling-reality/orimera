-- 0027_versioned_scene_builds.sql
-- Bind each reconstruction attempt to exact point-map inputs and retain successful rebuilds.

begin;

select pg_advisory_xact_lock(119622309);

alter table reconstruction_scene_job
  add column build_inputs jsonb,
  add column build_input_digest bytea,
  add column rung_assertion_id uuid;

update reconstruction_scene_job
   set build_inputs = jsonb_build_object(
         'profile', 'orimera.reconstruction-scene-build-input/legacy-v0',
         'point_maps', '[]'::jsonb),
       build_input_digest = digest(
         convert_to(
           '{"point_maps":[],"profile":'
           '"orimera.reconstruction-scene-build-input/legacy-v0"}',
           'UTF8'),
         'sha256');

alter table reconstruction_scene_job
  alter column build_inputs set not null,
  alter column build_input_digest set not null,
  add check (octet_length(build_input_digest) = 32);

do $$
declare
  old_constraint text;
begin
  select conname
    into old_constraint
    from pg_constraint
   where conrelid = 'reconstruction_scene_job'::regclass
     and contype = 'u'
     and pg_get_constraintdef(oid) =
       'UNIQUE (workspace_id, scene_id, selection_policy_digest)';
  if old_constraint is not null then
    execute format(
      'alter table reconstruction_scene_job drop constraint %I',
      old_constraint);
  end if;
end $$;

alter table reconstruction_scene_job
  add unique (
    workspace_id,
    scene_id,
    selection_policy_digest,
    build_input_digest),
  add unique (workspace_id, scene_id, job_id);

alter table assertion
  add constraint assertion_workspace_assertion_uniq
  unique (workspace_id, assertion_id);

alter table reconstruction_scene_job
  add foreign key (workspace_id, rung_assertion_id)
    references assertion(workspace_id, assertion_id);

create function tg_reconstruction_scene_job_inputs_immutable() returns trigger
language plpgsql as $fn$
begin
  if new.job_id is distinct from old.job_id
     or new.workspace_id is distinct from old.workspace_id
     or new.scene_id is distinct from old.scene_id
     or new.member_digest is distinct from old.member_digest
     or new.selection_policy is distinct from old.selection_policy
     or new.selection_policy_digest is distinct from old.selection_policy_digest
     or new.build_inputs is distinct from old.build_inputs
     or new.build_input_digest is distinct from old.build_input_digest
     or new.created_at is distinct from old.created_at then
    raise exception 'reconstruction scene job inputs are immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_reconstruction_scene_job_inputs_immutable
  before update on reconstruction_scene_job
  for each row execute function tg_reconstruction_scene_job_inputs_immutable();

create table reconstruction_scene_build_member (
  workspace_id uuid not null,
  job_id       uuid not null,
  capture_id   uuid not null,
  ordinal      int not null check (ordinal >= 0),
  registered   boolean not null,
  primary key (workspace_id, job_id, capture_id),
  unique (workspace_id, job_id, ordinal),
  foreign key (workspace_id, job_id, capture_id)
    references reconstruction_scene_job_member(workspace_id, job_id, capture_id)
);

insert into reconstruction_scene_build_member (
  workspace_id,
  job_id,
  capture_id,
  ordinal,
  registered)
select j.workspace_id,
       j.job_id,
       m.capture_id,
       m.ordinal,
       sm.registered
  from reconstruction_scene_job j
  join reconstruction_scene_job_member m
    on m.workspace_id = j.workspace_id
   and m.job_id = j.job_id
  join reconstruction_scene_member sm
    on sm.workspace_id = j.workspace_id
   and sm.scene_id = j.scene_id
   and sm.capture_id = m.capture_id
 where j.status = 'succeeded';

create function tg_reconstruction_scene_build_member_live() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if not exists (
    select 1
      from reconstruction_scene_job j
     where j.workspace_id = new.workspace_id
       and j.job_id = new.job_id
       and j.status = 'running'
       and not tombstone_blocks_reconstruction_job(j.workspace_id, j.job_id)) then
    raise exception 'a reconstruction build outcome requires one live running job'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_reconstruction_scene_build_member_live
  before insert on reconstruction_scene_build_member
  for each row execute function tg_reconstruction_scene_build_member_live();

alter table reconstruction_scene
  add column current_job_id uuid;

create or replace function tg_reconstruction_scene_append_only() returns trigger
language plpgsql as $fn$
begin
  if tg_table_name = 'reconstruction_scene' and tg_op = 'UPDATE' then
    if to_jsonb(new) - 'current_job_id' = to_jsonb(old) - 'current_job_id'
       and to_jsonb(new) ->> 'current_job_id' is not null
       and exists (
         select 1
           from reconstruction_scene_job candidate
           left join reconstruction_scene_job previous
             on previous.workspace_id = (to_jsonb(old) ->> 'workspace_id')::uuid
            and previous.job_id = (to_jsonb(old) ->> 'current_job_id')::uuid
          where candidate.workspace_id = (to_jsonb(new) ->> 'workspace_id')::uuid
            and candidate.scene_id = (to_jsonb(new) ->> 'scene_id')::uuid
            and candidate.job_id = (to_jsonb(new) ->> 'current_job_id')::uuid
            and candidate.status = 'succeeded'
            and (previous.job_id is null
                 or candidate.completed_at >= previous.completed_at)) then
      return new;
    end if;
  end if;
  raise exception '% is append-only: a membership deletion can reach is not editable',
    tg_table_name
    using errcode = 'integrity_constraint_violation',
          hint = 'Scene identity and membership are immutable; only its current build pointer '
                 'may advance.';
end $fn$;

update reconstruction_scene s
   set current_job_id = (
    select j.job_id
      from reconstruction_scene_job j
     where j.workspace_id = s.workspace_id
       and j.scene_id = s.scene_id
       and j.status = 'succeeded'
     order by j.completed_at desc nulls last, j.created_at desc, j.job_id desc
     limit 1
  )
 where exists (
    select 1
      from reconstruction_scene_job j
     where j.workspace_id = s.workspace_id
       and j.scene_id = s.scene_id
       and j.status = 'succeeded');

update reconstruction_scene_job j
   set rung_assertion_id = current_claim.assertion_id
  from reconstruction_scene s,
       lateral (
         select a.assertion_id
           from assertion a
           join predicate p on p.predicate_id = a.predicate_id
          where a.workspace_id = s.workspace_id
            and a.subject_ref ->> 'type' = 'scene'
            and a.subject_ref ->> 'id' = s.scene_id::text
            and a.status = 'active'
            and p.key = 'reconstruction_scene_rung_is'
          order by a.asserted_at desc, a.assertion_id desc
          limit 1
       ) current_claim
 where s.workspace_id = j.workspace_id
   and s.current_job_id = j.job_id;

alter table reconstruction_scene
  add foreign key (workspace_id, scene_id, current_job_id)
    references reconstruction_scene_job(workspace_id, scene_id, job_id);

create function tg_reconstruction_scene_build_member_append_only() returns trigger
language plpgsql as $fn$
begin
  raise exception 'reconstruction_scene_build_member is append-only'
    using errcode = 'integrity_constraint_violation';
end $fn$;

create trigger tg_reconstruction_scene_build_member_append_only
  before update or delete on reconstruction_scene_build_member
  for each row execute function tg_reconstruction_scene_build_member_append_only();

alter table reconstruction_scene_build_member enable row level security;
alter table reconstruction_scene_build_member force row level security;
create policy ws_isolation on reconstruction_scene_build_member
  using (workspace_id = current_workspace())
  with check (workspace_id = current_workspace());

comment on column reconstruction_scene_job.build_inputs is
  'Canonical record of the exact immutable artifacts and stage versions consumed by this build.';
comment on column reconstruction_scene_job.rung_assertion_id is
  'Exact scene-rung claim published by this successful build.';
comment on column reconstruction_scene.current_job_id is
  'Latest successfully published build for this stable exact-member scene identity.';
comment on table reconstruction_scene_build_member is
  'Per-build registration outcome. Rebuilds never rewrite an earlier pose result.';

commit;

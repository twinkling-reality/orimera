-- 0021_interaction_policy_versions.sql
-- Durable, reviewed interaction preferences.  This plane contains no camera pose, open panel,
-- pending choice, conversation transcript, topology, renderer code, or neural weights.

begin;

select pg_advisory_xact_lock(119622309);

create table interaction_capability_registry (
  capability_key       text not null check (capability_key ~ '^[a-z][a-z0-9.-]*$'),
  capability_version   int not null check (capability_version >= 1),
  category             text not null check (
                         category in ('comfort','navigation','disclosure','initiative')),
  value_kind           text not null check (value_kind in ('integer','choice','toggle')),
  minimum_value        int,
  maximum_value        int,
  choice_values        jsonb,
  default_value        jsonb not null,
  description          text not null check (length(btrim(description)) > 0),
  registered_at        timestamptz not null default now(),
  primary key (capability_key,capability_version),
  constraint interaction_integer_bounds_are_complete check (
    value_kind <> 'integer' or
    (minimum_value is not null and maximum_value is not null and minimum_value < maximum_value)),
  constraint interaction_choices_are_complete check (
    value_kind <> 'choice' or
    (jsonb_typeof(choice_values)='array' and jsonb_array_length(choice_values) >= 2))
);

insert into interaction_capability_registry
  (capability_key,capability_version,category,value_kind,minimum_value,maximum_value,
   choice_values,default_value,description)
values
  ('comfort.field-of-view-degrees',1,'comfort','integer',60,90,null,'70',
   'Vertical field of view in reviewed whole-degree bounds.'),
  ('comfort.look-sensitivity-milli',1,'comfort','integer',500,2000,null,'1000',
   'Look sensitivity as fixed-point thousandths of the measured default.'),
  ('comfort.vignette',1,'comfort','choice',null,null,'["off","subtle","strong"]','"subtle"',
   'Peripheral movement vignette strength; it never hides evidence.'),
  ('comfort.camera-bob',1,'comfort','toggle',null,null,null,'false',
   'Optional camera bob, disabled by default for comfort.'),
  ('navigation.turn-mode',1,'navigation','choice',null,null,'["smooth","snap"]','"smooth"',
   'Smooth turning or reviewed thirty-degree snap turning.'),
  ('navigation.transition-style',1,'navigation','choice',null,null,'["motion","fade"]','"motion"',
   'Movement transition after device reduced-motion preference has been resolved.'),
  ('disclosure.provenance-detail',1,'disclosure','choice',null,null,
   '["standard","expanded"]','"standard"',
   'Amount of provenance detail shown by default; evidence access is never disabled.'),
  ('initiative.mode',1,'initiative','choice',null,null,'["normal","minimal","off"]','"normal"',
   'Companion initiative mode; minimal and off both prohibit spontaneous speech.');

create table world_interaction_policy_version (
  version_id                 uuid primary key default uuidv7(),
  workspace_id               uuid not null,
  world_id                    text not null check (length(world_id) between 1 and 200),
  revision                    bigint not null check (revision >= 0),
  parent_version_id           uuid,
  parameters                  jsonb not null check (jsonb_typeof(parameters)='object'),
  policy_sha256               text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  applied_from_proposal_id    uuid,
  rollback_target_version_id  uuid,
  origin                      text not null check (origin in ('user','settings','companion')),
  actor                       uuid not null,
  origin_reference            text,
  created_at                  timestamptz not null default now(),
  unique (workspace_id,world_id,version_id),
  unique (workspace_id,world_id,revision),
  unique (workspace_id,world_id,policy_sha256,version_id),
  foreign key (workspace_id,world_id,parent_version_id)
    references world_interaction_policy_version(workspace_id,world_id,version_id),
  foreign key (workspace_id,world_id,rollback_target_version_id)
    references world_interaction_policy_version(workspace_id,world_id,version_id),
  constraint interaction_origin_reference_is_attributed check (
    origin='user' or length(btrim(origin_reference)) > 0)
);

create table world_interaction_policy_state (
  workspace_id       uuid not null,
  world_id           text not null,
  current_version_id uuid not null,
  updated_at         timestamptz not null default now(),
  primary key (workspace_id,world_id),
  foreign key (workspace_id,world_id,current_version_id)
    references world_interaction_policy_version(workspace_id,world_id,version_id)
);

create table world_interaction_policy_proposal (
  proposal_id               uuid primary key,
  workspace_id              uuid not null,
  world_id                   text not null,
  origin                     text not null check (origin in ('user','settings','companion')),
  actor                      uuid not null,
  origin_reference           text,
  model_id                   text,
  prompt_version             text,
  proposal_input             jsonb not null check (jsonb_typeof(proposal_input)='object'),
  reference_ids              text[] not null default '{}',
  explanation                text not null check (length(btrim(explanation)) > 0),
  capability_patch           jsonb not null check (jsonb_typeof(capability_patch)='object'),
  base_policy_version_id     uuid,
  base_structure_snapshot_id uuid,
  base_topology_sha256       text,
  refines_proposal_id        uuid,
  status                     text not null check (
                               status in ('previewed','rejected','applied','discarded','stale')),
  validation_issues          jsonb not null default '[]'
                               check (jsonb_typeof(validation_issues)='array'),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (workspace_id,world_id,proposal_id),
  -- Base and refinement ids are untrusted request data. Rejected/stale proposals are still audit
  -- records, so strict foreign keys belong on applied versions and previews, not on these inputs.
  constraint interaction_structure_base_is_complete check (
    (base_structure_snapshot_id is null and base_topology_sha256 is null) or
    (base_structure_snapshot_id is not null and base_topology_sha256 ~ '^[0-9a-f]{64}$')),
  constraint interaction_proposal_origin_is_attributed check (
    origin='user' or length(btrim(origin_reference)) > 0),
  constraint companion_model_provenance_is_complete check (
    (origin='companion' and length(btrim(model_id)) > 0 and
     length(btrim(prompt_version)) > 0 and cardinality(reference_ids) > 0) or
    (origin<>'companion' and model_id is null and prompt_version is null))
);

create table world_interaction_policy_preview (
  preview_id            uuid primary key default uuidv7(),
  workspace_id          uuid not null,
  world_id               text not null,
  proposal_id           uuid not null,
  candidate_parameters  jsonb not null check (jsonb_typeof(candidate_parameters)='object'),
  candidate_sha256      text not null check (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  status                text not null default 'open'
                          check (status in ('open','applied','discarded','stale')),
  created_at            timestamptz not null default now(),
  closed_at             timestamptz,
  unique (workspace_id,world_id,preview_id),
  unique (workspace_id,world_id,proposal_id),
  foreign key (workspace_id,world_id,proposal_id)
    references world_interaction_policy_proposal(workspace_id,world_id,proposal_id)
);

create table world_interaction_policy_audit_event (
  event_id          uuid primary key default uuidv7(),
  workspace_id      uuid not null,
  world_id           text not null,
  event_type         text not null check (
                       event_type in ('proposal_rejected','preview_created','proposal_refined',
                                      'preview_applied','preview_discarded','preview_stale',
                                      'policy_rolled_back')),
  origin             text not null check (origin in ('user','settings','companion')),
  actor              uuid not null,
  origin_reference   text,
  proposal_id        uuid,
  preview_id         uuid,
  version_id         uuid,
  details            jsonb not null default '{}' check (jsonb_typeof(details)='object'),
  occurred_at        timestamptz not null default now(),
  foreign key (workspace_id,world_id,proposal_id)
    references world_interaction_policy_proposal(workspace_id,world_id,proposal_id),
  foreign key (workspace_id,world_id,preview_id)
    references world_interaction_policy_preview(workspace_id,world_id,preview_id),
  foreign key (workspace_id,world_id,version_id)
    references world_interaction_policy_version(workspace_id,world_id,version_id),
  constraint interaction_audit_origin_is_attributed check (
    origin='user' or length(btrim(origin_reference)) > 0)
);

alter table world_interaction_policy_version
  add constraint interaction_version_proposal_fk
  foreign key (workspace_id,world_id,applied_from_proposal_id)
  references world_interaction_policy_proposal(workspace_id,world_id,proposal_id);

create function tg_interaction_append_only() returns trigger language plpgsql as $fn$
begin
  raise exception '% is append-only',tg_table_name
    using errcode='integrity_constraint_violation';
end $fn$;

create function tg_interaction_proposal_lifecycle_only() returns trigger language plpgsql as $fn$
begin
  if (to_jsonb(new)-'status'-'updated_at') is distinct from
     (to_jsonb(old)-'status'-'updated_at') then
    raise exception 'interaction proposal input, mapping, bases, and provenance are immutable'
      using errcode='integrity_constraint_violation';
  end if;
  if new.status is distinct from old.status and
     not (old.status='previewed' and new.status in ('applied','discarded','stale')) then
    raise exception 'interaction proposal lifecycle cannot move from % to %',old.status,new.status
      using errcode='integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_interaction_proposal_lifecycle_only
  before update on world_interaction_policy_proposal
  for each row execute function tg_interaction_proposal_lifecycle_only();

create function tg_interaction_preview_lifecycle_only() returns trigger language plpgsql as $fn$
begin
  if (to_jsonb(new)-'status'-'closed_at') is distinct from
     (to_jsonb(old)-'status'-'closed_at') then
    raise exception 'interaction preview candidate is immutable'
      using errcode='integrity_constraint_violation';
  end if;
  if new.status is distinct from old.status and
     not (old.status='open' and new.status in ('applied','discarded','stale')) then
    raise exception 'interaction preview lifecycle cannot move from % to %',old.status,new.status
      using errcode='integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_interaction_preview_lifecycle_only
  before update on world_interaction_policy_preview
  for each row execute function tg_interaction_preview_lifecycle_only();

create function tg_interaction_state_moves_forward() returns trigger language plpgsql as $fn$
declare
  candidate record;
begin
  select revision,parent_version_id into candidate
  from world_interaction_policy_version
  where workspace_id=new.workspace_id and world_id=new.world_id
    and version_id=new.current_version_id;
  if tg_op='INSERT' and candidate.revision <> 0 then
    raise exception 'initial interaction policy pointer must name revision zero'
      using errcode='integrity_constraint_violation';
  end if;
  if tg_op='UPDATE' and candidate.parent_version_id is distinct from old.current_version_id then
    raise exception 'interaction policy pointer may move only to a new direct child'
      using errcode='integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_interaction_state_moves_forward
  before insert or update on world_interaction_policy_state
  for each row execute function tg_interaction_state_moves_forward();

do $$
declare
  t text;
begin
  foreach t in array array[
    'world_interaction_policy_version','world_interaction_policy_audit_event'
  ] loop
    execute format(
      'create trigger %I before update or delete on %I '
      'for each row execute function tg_interaction_append_only()',
      'tg_' || t || '_append_only',t);
  end loop;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'world_interaction_policy_version','world_interaction_policy_state',
    'world_interaction_policy_proposal','world_interaction_policy_preview',
    'world_interaction_policy_audit_event'
  ] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format(
      'create policy ws_isolation on %I using (workspace_id=current_workspace()) '
      'with check (workspace_id=current_workspace())',t);
  end loop;
end $$;

-- Registries are reviewed code/migration data. Existing runtime roles may read but cannot mutate.
do $$
declare
  r text;
begin
  foreach r in array array['orimera_app','orimera_ro'] loop
    if exists (select 1 from pg_roles where rolname=r) then
      execute format(
        'revoke insert,update on interaction_capability_registry from %I',r);
    end if;
  end loop;
end $$;

create index interaction_policy_history_idx
  on world_interaction_policy_version(workspace_id,world_id,revision desc);
create index interaction_policy_preview_open_idx
  on world_interaction_policy_preview(workspace_id,world_id,created_at) where status='open';
create index interaction_policy_proposal_observation_idx
  on world_interaction_policy_proposal(workspace_id,world_id,status,origin,created_at);
create index interaction_policy_audit_idx
  on world_interaction_policy_audit_event(workspace_id,world_id,occurred_at,event_id);

commit;

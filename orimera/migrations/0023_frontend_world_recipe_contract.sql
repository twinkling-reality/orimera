-- 0023_frontend_world_recipe_contract.sql
-- Exact renderer-neutral handshake with the reviewed Atlas recipe registry introduced by
-- frontend commit 55b1236.  Executable modules remain client code; these rows persist only their
-- reviewed identities, capability ownership, inert proposal values, and provenance.

begin;

select pg_advisory_xact_lock(119622309);

insert into world_style_capability_registry
  (capability_key, capability_version, parameter_kind, parameter_group,
   minimum_value, maximum_value)
values
  ('surface.finish', 1, 'choice', 'material', null, null),
  ('motion.tempo', 1, 'range', 'motion', 0.75, 1.25);

create table world_style_module_registry (
  module_id      text primary key check (module_id ~ '^[a-z][a-z0-9-]*-v[1-9][0-9]*$'),
  reviewed_at    timestamptz not null default now()
);

create table world_style_module_capability (
  module_id          text not null references world_style_module_registry(module_id),
  capability_key     text not null,
  capability_version int not null default 1,
  application_order  int not null check (application_order >= 0),
  primary key (module_id, capability_key, capability_version),
  unique (module_id, application_order),
  foreign key (capability_key, capability_version)
    references world_style_capability_registry(capability_key, capability_version)
);

create table world_art_profile_module (
  profile_id        text not null,
  profile_version   int not null,
  module_id         text not null references world_style_module_registry(module_id),
  application_order int not null check (application_order >= 0),
  primary key (profile_id, profile_version, module_id),
  unique (profile_id, profile_version, application_order),
  foreign key (profile_id, profile_version)
    references world_art_profile_registry(profile_id, profile_version)
);

insert into world_style_module_registry (module_id) values
  ('aeroheart-optics-v1'),
  ('registered-surface-v1'),
  ('bounded-tempo-v1'),
  ('survey-relief-response-v1');

insert into world_style_module_capability
  (module_id, capability_key, application_order)
values
  ('aeroheart-optics-v1', 'world.vitality', 0),
  ('aeroheart-optics-v1', 'material.transmission', 1),
  ('aeroheart-optics-v1', 'relationships.energy', 2),
  ('aeroheart-optics-v1', 'detail.ecology', 3),
  ('aeroheart-optics-v1', 'atmosphere.softness', 4),
  ('registered-surface-v1', 'surface.finish', 0),
  ('bounded-tempo-v1', 'motion.tempo', 0),
  ('survey-relief-response-v1', 'detail.contours', 0),
  ('survey-relief-response-v1', 'material.technical-contrast', 1);

insert into world_art_profile_module
  (profile_id, profile_version, module_id, application_order)
values
  ('origin-landscape', 1, 'aeroheart-optics-v1', 0),
  ('origin-landscape', 1, 'registered-surface-v1', 1),
  ('origin-landscape', 1, 'bounded-tempo-v1', 2),
  ('survey-relief', 1, 'survey-relief-response-v1', 0);

update world_art_profile_registry
set description='Photographic memory veils above a luminous relationship tide.'
where profile_id='origin-landscape' and profile_version=1;

update world_art_profile_parameter set
  label='Color vitality',
  description='Tunes one shared color family across the memory field and its interface surfaces.'
where profile_id='origin-landscape' and profile_version=1 and parameter_key='vitality';
update world_art_profile_parameter set
  label='Veil clarity',
  description='Changes the memory weave from soft optical thread to a crisp source image.'
where profile_id='origin-landscape' and profile_version=1 and parameter_key='glass';
update world_art_profile_parameter set
  description='Controls the visual strength of confirmed relationship filaments.'
where profile_id='origin-landscape' and profile_version=1 and parameter_key='relationship-energy';
update world_art_profile_parameter set
  label='Weave detail',
  description='Controls bounded source-thread detail without adding, removing, or implying evidence.'
where profile_id='origin-landscape' and profile_version=1 and parameter_key='garden-density';

insert into world_art_profile_parameter
  (profile_id, profile_version, parameter_key, capability_key, label, description,
   minimum_value, maximum_value, step_value, default_value, choice_values)
values
  ('origin-landscape',1,'surface-finish','surface.finish','Surface finish',
   'Uses one registered finish across the field and summoned interface surfaces.',
   null,null,null,'"source-paper"','["source-paper","clear-lens"]'),
  ('origin-landscape',1,'world-tempo','motion.tempo','Memory tempo',
   'Changes the shared ambient and interface cadence inside a calm, bounded range.',
   0.75,1.25,0.05,'1',null);

alter table world_style_proposal
  add column provenance_schema_version int not null default 0,
  add column reference_ids text[] not null default '{}',
  add column model_id text,
  add column prompt_version text,
  add column refines_proposal_id uuid,
  add column recipe_binding jsonb not null default '{}',
  add column capability_mapping jsonb not null default '{}';

alter table world_style_proposal alter column provenance_schema_version set default 1;
alter table world_style_proposal add constraint world_style_proposal_provenance_v1 check (
  (provenance_schema_version=0 and model_id is null and prompt_version is null) or
  (provenance_schema_version=1 and
   ((origin='companion' and length(btrim(model_id)) > 0 and
   length(btrim(prompt_version)) > 0 and cardinality(reference_ids) > 0) or
    (origin<>'companion' and model_id is null and prompt_version is null)) and
   jsonb_typeof(recipe_binding)='object' and recipe_binding <> '{}' and
   jsonb_typeof(capability_mapping)='object')
);

alter table world_style_version
  add column provenance_schema_version int not null default 0,
  add column reference_ids text[] not null default '{}',
  add column model_id text,
  add column prompt_version text,
  add column refines_proposal_id uuid,
  add column recipe_binding jsonb not null default '{}',
  add column capability_mapping jsonb not null default '{}';

alter table world_style_version alter column provenance_schema_version set default 1;
alter table world_style_version add constraint world_style_version_provenance_v1 check (
  provenance_schema_version=0 or
  (provenance_schema_version=1 and
   jsonb_typeof(recipe_binding)='object' and recipe_binding <> '{}' and
   jsonb_typeof(capability_mapping)='object' and capability_mapping <> '{}')
);

-- Schema zero exists only to preserve rows written before this migration. New rows cannot opt out
-- of the recipe/provenance contract by explicitly supplying the historical discriminator.
create function tg_world_recipe_provenance_v1() returns trigger language plpgsql as $fn$
begin
  if new.provenance_schema_version <> 1 then
    raise exception 'new world style rows require recipe provenance schema version 1'
      using errcode='integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_world_style_proposal_recipe_provenance_v1
  before insert on world_style_proposal
  for each row execute function tg_world_recipe_provenance_v1();
create trigger tg_world_style_version_recipe_provenance_v1
  before insert on world_style_version
  for each row execute function tg_world_recipe_provenance_v1();

create index world_style_refinement_idx
  on world_style_proposal (workspace_id, world_id, refines_proposal_id)
  where refines_proposal_id is not null;

do $$
declare
  r text;
  t text;
begin
  foreach r in array array['orimera_app','orimera_ro'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array[
        'world_style_module_registry','world_style_module_capability','world_art_profile_module'
      ] loop
        execute format('revoke insert, update, delete on %I from %I', t, r);
      end loop;
    end if;
  end loop;
end $$;

commit;

-- 0017_adaptive_world_styles.sql
-- Backend authority for the appearance-only half of ADR-0007.
--
-- The renderer still owns realization.  These tables persist only reviewed profile references,
-- capability-backed scalar values, protected topology/source contracts, immutable style history,
-- isolated previews, and audit provenance.  There is deliberately nowhere to store CSS, markup,
-- JavaScript, shaders, remote texture URLs, or interface layout.

begin;

select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. Reviewed, versioned registries.  Runtime roles read these and cannot write them.
-- --------------------------------------------------------------------------------------------

create table world_style_capability_registry (
  capability_key     text not null check (capability_key ~ '^[a-z][a-z0-9.-]*$'),
  capability_version int not null check (capability_version >= 1),
  parameter_kind     text not null check (parameter_kind in ('range','choice','color','toggle')),
  parameter_group    text not null check (
                       parameter_group in ('world','material','atmosphere','motion','detail')),
  minimum_value      double precision,
  maximum_value      double precision,
  reviewed_at        timestamptz not null default now(),
  primary key (capability_key, capability_version),
  constraint world_range_capability_has_ordered_bounds check (
    parameter_kind <> 'range' or
    (minimum_value is not null and maximum_value is not null and minimum_value < maximum_value))
);

create table world_art_profile_registry (
  profile_id               text not null check (profile_id ~ '^[a-z][a-z0-9.-]*$'),
  profile_version          int not null check (profile_version >= 1),
  display_name             text not null check (length(btrim(display_name)) > 0),
  description              text not null check (length(btrim(description)) > 0),
  compatibility_key        text not null check (length(btrim(compatibility_key)) > 0),
  status                   text not null check (
                             status in ('supported','experimental','removed','unsupported')),
  fallback_profile_id      text not null,
  fallback_profile_version int not null,
  is_default               boolean not null default false,
  registered_at            timestamptz not null default now(),
  primary key (profile_id, profile_version),
  foreign key (fallback_profile_id, fallback_profile_version)
    references world_art_profile_registry(profile_id, profile_version) deferrable initially deferred
);

create unique index world_art_profile_one_default
  on world_art_profile_registry (is_default) where is_default;

create table world_art_profile_parameter (
  profile_id          text not null,
  profile_version     int not null,
  parameter_key       text not null check (parameter_key ~ '^[a-z][a-z0-9.-]*$'),
  capability_key      text not null,
  capability_version  int not null default 1,
  label                text not null check (length(btrim(label)) > 0),
  description          text not null check (length(btrim(description)) > 0),
  minimum_value        double precision,
  maximum_value        double precision,
  step_value           double precision,
  default_value        jsonb not null,
  choice_values        jsonb,
  primary key (profile_id, profile_version, parameter_key),
  foreign key (profile_id, profile_version)
    references world_art_profile_registry(profile_id, profile_version),
  foreign key (capability_key, capability_version)
    references world_style_capability_registry(capability_key, capability_version),
  constraint world_profile_range_is_ordered check (
    minimum_value is null or
    (maximum_value is not null and step_value is not null and
     minimum_value < maximum_value and step_value > 0))
);

insert into world_style_capability_registry
  (capability_key, capability_version, parameter_kind, parameter_group,
   minimum_value, maximum_value)
values
  ('world.vitality',                 1, 'range', 'world',      0, 1),
  ('material.transmission',          1, 'range', 'material',   0, 1),
  ('relationships.energy',           1, 'range', 'motion',     0, 1),
  ('detail.ecology',                 1, 'range', 'detail',     0, 1),
  ('atmosphere.softness',            1, 'range', 'atmosphere', 0, 1),
  ('detail.contours',                1, 'range', 'detail',     0, 1),
  ('material.technical-contrast',    1, 'range', 'material',   0, 1);

set constraints all deferred;
insert into world_art_profile_registry
  (profile_id, profile_version, display_name, description, compatibility_key, status,
   fallback_profile_id, fallback_profile_version, is_default)
values
  ('origin-landscape', 1, 'Aeroheart',
   'A bright living memory ecology of glass lenses, water paths, and vector signals.',
   'atlas-topology-v1', 'supported', 'origin-landscape', 1, true),
  ('survey-relief', 1, 'Survey Relief (experimental)',
   'A topology-compatible field-ledger study for renderer regression tests.',
   'atlas-topology-v1', 'experimental', 'origin-landscape', 1, false);

insert into world_art_profile_parameter
  (profile_id, profile_version, parameter_key, capability_key, label, description,
   minimum_value, maximum_value, step_value, default_value)
values
  ('origin-landscape',1,'vitality','world.vitality','World vitality',
   'Moves the living world from quiet to vividly saturated.',0,1,0.05,'0.82'),
  ('origin-landscape',1,'glass','material.transmission','Glass character',
   'Changes memory lenses from soft translucent forms to crisp optical glass.',0,1,0.05,'0.76'),
  ('origin-landscape',1,'relationship-energy','relationships.energy','Relationship energy',
   'Controls the visual strength of confirmed relationship paths.',0,1,0.05,'0.68'),
  ('origin-landscape',1,'garden-density','detail.ecology','Garden density',
   'Controls decorative growth without adding or removing memories.',0,1,0.05,'0.72'),
  ('origin-landscape',1,'horizon-softness','atmosphere.softness','Horizon softness',
   'Changes atmospheric depth without hiding destinations.',0,1,0.05,'0.46'),
  ('survey-relief',1,'contour-density','detail.contours','Contour density',
   'Changes the number of non-semantic survey contour marks.',0,1,0.1,'0.55'),
  ('survey-relief',1,'technical-contrast','material.technical-contrast','Technical contrast',
   'Controls separation between survey strata and their field.',0,1,0.1,'0.7');

-- A composite foreign key below makes a topology source incapable of naming another workspace's
-- evidence.  A plain span_id foreign key would prove existence globally and would not prove
-- authorisation.
alter table evidence_span add constraint evidence_span_workspace_span_uniq
  unique (workspace_id, span_id);

-- --------------------------------------------------------------------------------------------
-- 2. Protected topology and source-media slots.  Append-only; only the current pointer moves.
-- --------------------------------------------------------------------------------------------

create table world_topology_contract (
  workspace_id    uuid not null,
  world_id         text not null default 'atlas:default'
                   check (length(world_id) between 1 and 200),
  topology_digest  text not null check (length(topology_digest) between 1 and 256),
  compatibility_key text not null check (length(btrim(compatibility_key)) > 0),
  registered_at    timestamptz not null default now(),
  primary key (workspace_id, world_id, topology_digest)
);

create table world_topology_region (
  workspace_id    uuid not null,
  world_id         text not null,
  topology_digest  text not null,
  region_id        text not null check (length(region_id) between 1 and 500),
  primary key (workspace_id, world_id, topology_digest, region_id),
  foreign key (workspace_id, world_id, topology_digest)
    references world_topology_contract(workspace_id, world_id, topology_digest)
);

create table world_topology_source (
  source_id         uuid not null default uuidv7(),
  workspace_id      uuid not null,
  world_id           text not null,
  topology_digest    text not null,
  region_id          text,
  slot_key           text not null check (slot_key ~ '^[a-z][a-z0-9.-]*$'),
  evidence_span_id   uuid,
  missing_reason     text,
  primary key (workspace_id, world_id, topology_digest, source_id),
  unique nulls not distinct (workspace_id, world_id, topology_digest, region_id, slot_key),
  foreign key (workspace_id, world_id, topology_digest)
    references world_topology_contract(workspace_id, world_id, topology_digest),
  foreign key (workspace_id, world_id, topology_digest, region_id)
    references world_topology_region(workspace_id, world_id, topology_digest, region_id),
  foreign key (workspace_id, evidence_span_id)
    references evidence_span(workspace_id, span_id),
  constraint world_source_is_evidence_or_an_honest_gap check (
    (evidence_span_id is not null and missing_reason is null) or
    (evidence_span_id is null and length(btrim(missing_reason)) > 0))
);

-- --------------------------------------------------------------------------------------------
-- 3. Immutable style versions and their one mutable current pointer.
-- --------------------------------------------------------------------------------------------

create table world_style_version (
  version_id                uuid primary key default uuidv7(),
  workspace_id              uuid not null,
  world_id                   text not null,
  revision                   bigint not null check (revision >= 0),
  parent_version_id          uuid,
  topology_digest            text not null,
  global_profile_id          text not null,
  global_profile_version     int not null,
  global_parameters          jsonb not null check (jsonb_typeof(global_parameters) = 'object'),
  applied_from_proposal_id   uuid,
  rollback_target_version_id uuid,
  origin                     text check (origin in ('user','settings','companion')),
  actor                      uuid,
  origin_reference           text,
  created_at                 timestamptz not null default now(),
  unique (workspace_id, world_id, version_id),
  unique (workspace_id, world_id, revision),
  foreign key (workspace_id, world_id, topology_digest)
    references world_topology_contract(workspace_id, world_id, topology_digest),
  foreign key (workspace_id, world_id, parent_version_id)
    references world_style_version(workspace_id, world_id, version_id),
  foreign key (workspace_id, world_id, rollback_target_version_id)
    references world_style_version(workspace_id, world_id, version_id),
  foreign key (global_profile_id, global_profile_version)
    references world_art_profile_registry(profile_id, profile_version),
  constraint world_style_origin_is_complete check (
    (revision = 0 and parent_version_id is null and origin is null and actor is null) or
    (revision > 0 and parent_version_id is not null and origin is not null and actor is not null)),
  constraint world_style_origin_reference_is_attributed check (
    origin is null or origin = 'user' or length(btrim(origin_reference)) > 0)
);

create table world_region_style_version (
  workspace_id    uuid not null,
  world_id         text not null,
  version_id       uuid not null,
  topology_digest  text not null,
  region_id        text not null,
  profile_id       text not null,
  profile_version  int not null,
  parameters       jsonb not null check (jsonb_typeof(parameters) = 'object'),
  primary key (workspace_id, world_id, version_id, region_id),
  foreign key (workspace_id, world_id, version_id)
    references world_style_version(workspace_id, world_id, version_id),
  foreign key (workspace_id, world_id, topology_digest, region_id)
    references world_topology_region(workspace_id, world_id, topology_digest, region_id),
  foreign key (profile_id, profile_version)
    references world_art_profile_registry(profile_id, profile_version)
);

create table world_style_state (
  workspace_id           uuid not null,
  world_id                text not null,
  current_topology_digest text not null,
  current_style_version_id uuid not null,
  updated_at              timestamptz not null default now(),
  primary key (workspace_id, world_id),
  foreign key (workspace_id, world_id, current_topology_digest)
    references world_topology_contract(workspace_id, world_id, topology_digest),
  foreign key (workspace_id, world_id, current_style_version_id)
    references world_style_version(workspace_id, world_id, version_id)
);

-- --------------------------------------------------------------------------------------------
-- 4. Proposals and isolated previews.  Candidate JSON is backend-produced and never executable.
-- --------------------------------------------------------------------------------------------

create table world_style_proposal (
  proposal_id             uuid primary key,
  workspace_id            uuid not null,
  world_id                 text not null,
  origin                   text not null check (origin in ('user','settings','companion')),
  actor                    uuid not null,
  origin_reference         text,
  scope_kind               text not null check (scope_kind in ('global','region')),
  scope_region_id          text,
  base_style_version_id    uuid not null,
  base_topology_digest     text not null,
  profile_id               text not null,
  profile_version          int not null,
  parameters               jsonb not null check (jsonb_typeof(parameters) = 'object'),
  status                   text not null check (
                             status in ('previewed','rejected','applied','discarded','stale')),
  validation_issues        jsonb not null default '[]' check (
                             jsonb_typeof(validation_issues) = 'array'),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (workspace_id, world_id, proposal_id),
  -- The requested base/profile may be stale or unknown.  Rejected proposals are still audit
  -- records, so these untrusted request values deliberately are not foreign keys.  Only a
  -- validated preview can become a style version, and versions carry the strict foreign keys.
  constraint world_style_scope_is_exact check (
    (scope_kind = 'global' and scope_region_id is null) or
    (scope_kind = 'region' and scope_region_id is not null)),
  constraint world_style_proposal_origin_is_attributed check (
    origin = 'user' or length(btrim(origin_reference)) > 0)
);

create table world_style_preview (
  preview_id      uuid primary key default uuidv7(),
  workspace_id    uuid not null,
  world_id         text not null,
  proposal_id      uuid not null,
  candidate        jsonb not null check (jsonb_typeof(candidate) = 'object'),
  status           text not null default 'open' check (
                     status in ('open','applied','discarded','stale')),
  created_at       timestamptz not null default now(),
  closed_at        timestamptz,
  unique (workspace_id, world_id, preview_id),
  unique (workspace_id, world_id, proposal_id),
  foreign key (workspace_id, world_id, proposal_id)
    references world_style_proposal(workspace_id, world_id, proposal_id)
);

create table world_style_audit_event (
  event_id          uuid primary key default uuidv7(),
  workspace_id      uuid not null,
  world_id           text not null,
  event_type         text not null check (
                       event_type in ('proposal_rejected','preview_created','preview_applied',
                                      'preview_discarded','preview_stale','style_rolled_back')),
  origin             text not null check (origin in ('user','settings','companion')),
  actor              uuid not null,
  origin_reference   text,
  proposal_id        uuid,
  preview_id         uuid,
  style_version_id   uuid,
  details            jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  occurred_at        timestamptz not null default now(),
  foreign key (workspace_id, world_id, proposal_id)
    references world_style_proposal(workspace_id, world_id, proposal_id),
  foreign key (workspace_id, world_id, preview_id)
    references world_style_preview(workspace_id, world_id, preview_id),
  foreign key (workspace_id, world_id, style_version_id)
    references world_style_version(workspace_id, world_id, version_id),
  constraint world_style_audit_origin_is_attributed check (
    origin = 'user' or length(btrim(origin_reference)) > 0)
);

alter table world_style_version add constraint world_style_version_proposal_fk
  foreign key (workspace_id, world_id, applied_from_proposal_id)
  references world_style_proposal(workspace_id, world_id, proposal_id);

-- Versions, topology contracts, their children, and audit events are append-only.  Rollback is a
-- new version, never an UPDATE of history.  The current pointer and preview lifecycle are the
-- deliberately mutable rows.
create function tg_world_append_only() returns trigger language plpgsql as $fn$
begin
  raise exception '% is append-only; create a new version or contract', tg_table_name
    using errcode = 'integrity_constraint_violation';
end $fn$;

-- Proposal identity/provenance/request data and preview candidates are immutable too.  Only the
-- lifecycle columns may move, and naming those exceptions prevents a later route from quietly
-- turning UPDATE access into a way to replace an already validated candidate.
create function tg_world_proposal_lifecycle_only() returns trigger language plpgsql as $fn$
begin
  if (to_jsonb(new) - 'status' - 'updated_at') is distinct from
     (to_jsonb(old) - 'status' - 'updated_at') then
    raise exception 'world style proposal request and provenance are immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_world_style_proposal_lifecycle_only
  before update on world_style_proposal
  for each row execute function tg_world_proposal_lifecycle_only();

create function tg_world_preview_lifecycle_only() returns trigger language plpgsql as $fn$
begin
  if (to_jsonb(new) - 'status' - 'closed_at') is distinct from
     (to_jsonb(old) - 'status' - 'closed_at') then
    raise exception 'world style preview candidate is immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_world_style_preview_lifecycle_only
  before update on world_style_preview
  for each row execute function tg_world_preview_lifecycle_only();

do $$
declare
  t text;
begin
  foreach t in array array[
    'world_topology_contract','world_topology_region','world_topology_source',
    'world_style_version','world_region_style_version','world_style_audit_event'
  ] loop
    execute format(
      'create trigger %I before update or delete on %I '
      'for each row execute function tg_world_append_only()',
      'tg_' || t || '_append_only', t);
  end loop;
end $$;

-- --------------------------------------------------------------------------------------------
-- 5. Workspace isolation.  Global registries are not tenant data and are read-only by grant.
-- --------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'world_topology_contract','world_topology_region','world_topology_source',
    'world_style_version','world_region_style_version','world_style_state',
    'world_style_proposal','world_style_preview','world_style_audit_event'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy ws_isolation on %I using (workspace_id = current_workspace()) '
      'with check (workspace_id = current_workspace())', t);
  end loop;
end $$;

-- Existing runtime roles may already have received write access through ALTER DEFAULT
-- PRIVILEGES.  Revoke it now; db.roles repeats this for newly provisioned roles.
do $$
declare
  r text;
  t text;
begin
  foreach r in array array['orimera_app','orimera_ro'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array[
        'world_style_capability_registry','world_art_profile_registry',
        'world_art_profile_parameter'
      ] loop
        execute format('revoke insert, update on %I from %I', t, r);
      end loop;
    end if;
  end loop;
end $$;

create index world_style_version_history_idx
  on world_style_version (workspace_id, world_id, revision desc);
create index world_style_preview_open_idx
  on world_style_preview (workspace_id, world_id, created_at) where status = 'open';
create index world_style_audit_idx
  on world_style_audit_event (workspace_id, world_id, occurred_at, event_id);
create index world_topology_source_current_idx
  on world_topology_source (workspace_id, world_id, topology_digest, region_id, slot_key);

commit;

-- 0020_durable_spatial_authority.sql
-- Immutable structural world snapshots, protected previews, and deletion invalidation.
--
-- Coordinates in these documents are fixed-point integers.  This is not merely a storage
-- preference: orimera.canonical deliberately refuses IEEE-754 values in digest inputs, so the
-- backend and every independent package verifier hash exactly the same bytes.

begin;

select pg_advisory_xact_lock(119622309);

create table world_structure_snapshot (
  snapshot_id              uuid primary key default uuidv7(),
  workspace_id             uuid not null,
  world_id                  text not null check (length(world_id) between 1 and 200),
  revision                  bigint not null check (revision >= 0),
  parent_snapshot_id        uuid,
  graph_sha256              text not null check (graph_sha256 ~ '^[0-9a-f]{64}$'),
  reconstruction_sha256     text not null check (reconstruction_sha256 ~ '^[0-9a-f]{64}$'),
  topology_sha256           text not null check (topology_sha256 ~ '^[0-9a-f]{64}$'),
  layout_sha256             text not null check (layout_sha256 ~ '^[0-9a-f]{64}$'),
  placement_sha256          text not null check (placement_sha256 ~ '^[0-9a-f]{64}$'),
  neighborhood_sha256       text not null check (neighborhood_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256           text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  composer_key              text not null check (composer_key ~ '^[a-z][a-z0-9.-]*$'),
  composer_version          int not null check (composer_version >= 1),
  topology                  jsonb not null check (jsonb_typeof(topology) = 'object'),
  layout                    jsonb not null check (jsonb_typeof(layout) = 'object'),
  placement                 jsonb not null check (jsonb_typeof(placement) = 'object'),
  neighborhood              jsonb not null check (jsonb_typeof(neighborhood) = 'object'),
  package_projection        jsonb not null check (jsonb_typeof(package_projection) = 'object'),
  committed_by              uuid not null,
  created_at                timestamptz not null default now(),
  unique (workspace_id, world_id, snapshot_id),
  unique (workspace_id, world_id, revision),
  unique (workspace_id, world_id, snapshot_sha256),
  foreign key (workspace_id, world_id, parent_snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id),
  foreign key (workspace_id, world_id, topology_sha256)
    references world_topology_contract(workspace_id, world_id, topology_digest)
);

create table world_structure_state (
  workspace_id              uuid not null,
  world_id                   text not null,
  current_snapshot_id        uuid not null,
  current_graph_sha256       text not null check (current_graph_sha256 ~ '^[0-9a-f]{64}$'),
  current_reconstruction_sha256 text not null
                               check (current_reconstruction_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at                 timestamptz not null default now(),
  primary key (workspace_id, world_id),
  foreign key (workspace_id, world_id, current_snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id)
);

create table world_structure_preview (
  preview_id                 uuid primary key default uuidv7(),
  workspace_id               uuid not null,
  world_id                   text not null,
  base_snapshot_id           uuid,
  base_graph_sha256          text,
  base_reconstruction_sha256 text,
  candidate                  jsonb not null check (jsonb_typeof(candidate) = 'object'),
  protected_diff             jsonb not null check (jsonb_typeof(protected_diff) = 'object'),
  validation_checks          jsonb not null check (jsonb_typeof(validation_checks) = 'object'),
  status                     text not null default 'open'
                               check (status in ('open','applied','discarded','stale')),
  proposed_by                uuid not null,
  created_at                 timestamptz not null default now(),
  closed_at                  timestamptz,
  unique (workspace_id, world_id, preview_id),
  foreign key (workspace_id, world_id, base_snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id),
  constraint world_structure_preview_base_is_complete check (
    (base_snapshot_id is null and base_graph_sha256 is null
                              and base_reconstruction_sha256 is null) or
    (base_snapshot_id is not null and base_graph_sha256 ~ '^[0-9a-f]{64}$'
                                  and base_reconstruction_sha256 ~ '^[0-9a-f]{64}$'))
);

create table world_structure_element_identity (
  workspace_id       uuid not null,
  world_id           text not null,
  element_id         text not null check (length(element_id) between 1 and 500),
  owner_kind         text not null check (owner_kind in ('world','region','relationship')),
  owner_id           text not null check (length(owner_id) between 1 and 500),
  first_snapshot_id  uuid not null,
  created_at         timestamptz not null default now(),
  primary key (workspace_id, world_id, element_id),
  foreign key (workspace_id, world_id, first_snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id)
);

-- Region membership is repeated per snapshot so a placement migration can be checked without
-- interpreting JSON in SQL, and so package projection has a relational audit spine.
create table world_structure_snapshot_region (
  workspace_id       uuid not null,
  world_id           text not null,
  snapshot_id        uuid not null,
  region_id          text not null check (length(region_id) between 1 and 500),
  placement_sha256   text not null check (placement_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (workspace_id, world_id, snapshot_id, region_id),
  foreign key (workspace_id, world_id, snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id)
);

create table world_structure_snapshot_element (
  workspace_id       uuid not null,
  world_id           text not null,
  snapshot_id        uuid not null,
  element_id         text not null,
  region_id          text,
  placement_sha256   text not null check (placement_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (workspace_id, world_id, snapshot_id, element_id),
  foreign key (workspace_id, world_id, snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id),
  foreign key (workspace_id, world_id, element_id)
    references world_structure_element_identity(workspace_id, world_id, element_id),
  foreign key (workspace_id, world_id, snapshot_id, region_id)
    references world_structure_snapshot_region(workspace_id, world_id, snapshot_id, region_id)
    deferrable initially deferred
);

create table world_structure_dependency (
  dependency_id      uuid primary key default uuidv7(),
  workspace_id       uuid not null,
  world_id           text not null,
  snapshot_id        uuid not null,
  dependency_kind    text not null
                       check (dependency_kind in ('evidence_span','capture','entity','assertion')),
  dependency_ref     uuid not null,
  element_id         text,
  unique nulls not distinct
    (workspace_id, world_id, snapshot_id, dependency_kind, dependency_ref, element_id),
  foreign key (workspace_id, world_id, snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id),
  foreign key (workspace_id, world_id, snapshot_id, element_id)
    references world_structure_snapshot_element(workspace_id, world_id, snapshot_id, element_id)
);

create table world_structure_placement_migration (
  migration_id          uuid primary key,
  workspace_id          uuid not null,
  world_id               text not null,
  snapshot_id            uuid not null,
  region_id              text not null,
  from_placement_sha256  text not null check (from_placement_sha256 ~ '^[0-9a-f]{64}$'),
  to_placement_sha256    text not null check (to_placement_sha256 ~ '^[0-9a-f]{64}$'),
  reason                 text not null check (length(btrim(reason)) > 0),
  approved_by            uuid not null,
  created_at             timestamptz not null default now(),
  unique (workspace_id, world_id, snapshot_id, region_id),
  foreign key (workspace_id, world_id, snapshot_id, region_id)
    references world_structure_snapshot_region(workspace_id, world_id, snapshot_id, region_id)
);

create table world_structure_invalidation (
  invalidation_id     uuid primary key default uuidv7(),
  workspace_id        uuid not null,
  world_id             text not null,
  snapshot_id          uuid not null,
  tombstone_id         uuid not null references tombstone(tombstone_id),
  reason               text not null check (length(btrim(reason)) > 0),
  invalidated_at       timestamptz not null default now(),
  unique (workspace_id, world_id, snapshot_id, tombstone_id),
  foreign key (workspace_id, world_id, snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id)
);

create table world_structure_audit_event (
  event_id          uuid primary key default uuidv7(),
  workspace_id      uuid not null,
  world_id           text not null,
  event_type         text not null check (
                       event_type in ('preview_created','preview_applied','preview_discarded',
                                      'preview_stale','snapshot_invalidated')),
  actor              uuid,
  preview_id         uuid,
  snapshot_id        uuid,
  details            jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  occurred_at        timestamptz not null default now(),
  foreign key (workspace_id, world_id, preview_id)
    references world_structure_preview(workspace_id, world_id, preview_id),
  foreign key (workspace_id, world_id, snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id)
);

-- History and canonical candidate content are immutable.  Closing a preview is the sole update
-- allowed outside the current pointer.
create function tg_world_structure_append_only() returns trigger language plpgsql as $fn$
begin
  raise exception '% is append-only', tg_table_name
    using errcode = 'integrity_constraint_violation';
end $fn$;

create function tg_world_structure_preview_lifecycle_only() returns trigger language plpgsql as $fn$
begin
  if (to_jsonb(new) - 'status' - 'closed_at') is distinct from
     (to_jsonb(old) - 'status' - 'closed_at') then
    raise exception 'world structural preview candidate and bases are immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $fn$;

create trigger tg_world_structure_preview_lifecycle_only
  before update on world_structure_preview
  for each row execute function tg_world_structure_preview_lifecycle_only();

do $$
declare
  t text;
begin
  foreach t in array array[
    'world_structure_snapshot','world_structure_snapshot_region',
    'world_structure_element_identity','world_structure_snapshot_element',
    'world_structure_dependency','world_structure_placement_migration',
    'world_structure_invalidation','world_structure_audit_event'
  ] loop
    execute format(
      'create trigger %I before update or delete on %I '
      'for each row execute function tg_world_structure_append_only()',
      'tg_' || t || '_append_only', t);
  end loop;
end $$;

-- A tombstone and a structural commit serialize per workspace.  If deletion wins, the final
-- dependency guard refuses the commit; if composition wins, this trigger sees the committed
-- dependencies and invalidates the snapshot.  This closes the check/commit race without making
-- a renderer or a background sweep part of deletion correctness.
create function tg_world_structure_dependency_live() returns trigger language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if (new.dependency_kind = 'evidence_span' and not exists (
        select 1 from evidence_span s where s.workspace_id=new.workspace_id
          and s.span_id=new.dependency_ref)) or
     (new.dependency_kind = 'capture' and not exists (
        select 1 from capture c where c.workspace_id=new.workspace_id
          and c.capture_id=new.dependency_ref and c.deleted_at is null)) or
     (new.dependency_kind = 'entity' and not exists (
        select 1 from entity e where e.workspace_id=new.workspace_id
          and e.entity_id=new.dependency_ref and e.deleted_at is null)) or
     (new.dependency_kind = 'assertion' and not exists (
        select 1 from assertion a where a.workspace_id=new.workspace_id
          and a.assertion_id=new.dependency_ref and a.status='active')) then
    raise exception 'structural dependency is absent, cross-workspace, deleted, or inactive'
      using errcode = 'foreign_key_violation';
  end if;
  if (new.dependency_kind = 'evidence_span' and
      tombstone_blocks_any_span(new.workspace_id, array[new.dependency_ref])) or
     (new.dependency_kind = 'capture' and
      tombstone_blocks_capture(new.workspace_id, new.dependency_ref)) or
     (new.dependency_kind = 'entity' and
      tombstone_blocks_entity(new.workspace_id, new.dependency_ref)) or
     (new.dependency_kind = 'assertion' and exists (
       select 1 from tombstone t where t.workspace_id = new.workspace_id
         and t.effective_at <= clock_timestamp()
         and (t.scope = 'workspace' or
              (t.scope = 'assertion' and t.assertion_id = new.dependency_ref)))) then
    perform tombstone_refuse();
  end if;
  return new;
end $fn$;

create trigger tg_world_structure_dependency_live
  before insert on world_structure_dependency
  for each row execute function tg_world_structure_dependency_live();

create function tg_world_structure_invalidate_on_tombstone() returns trigger language plpgsql
as $fn$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 880024));

  insert into world_structure_invalidation
    (workspace_id,world_id,snapshot_id,tombstone_id,reason)
  select distinct s.workspace_id,s.world_id,s.snapshot_id,new.tombstone_id,
         'a committed tombstone covers a structural snapshot dependency'
    from world_structure_snapshot s
   where s.workspace_id = new.workspace_id
     and (
       new.scope = 'workspace' or exists (
         select 1 from world_structure_dependency d
          where d.workspace_id=s.workspace_id and d.world_id=s.world_id
            and d.snapshot_id=s.snapshot_id and (
              (d.dependency_kind='evidence_span' and
               tombstone_blocks_any_span(new.workspace_id,array[d.dependency_ref])) or
              (d.dependency_kind='capture' and new.scope in ('capture','interval') and
               d.dependency_ref=new.capture_id) or
              (d.dependency_kind='entity' and new.scope='entity' and
               d.dependency_ref=new.entity_id) or
              (d.dependency_kind='assertion' and new.scope='assertion' and
               d.dependency_ref=new.assertion_id)))
     )
  on conflict (workspace_id,world_id,snapshot_id,tombstone_id) do nothing;

  insert into world_structure_audit_event
    (workspace_id,world_id,event_type,snapshot_id,details)
  select i.workspace_id,i.world_id,'snapshot_invalidated',i.snapshot_id,
         jsonb_build_object('tombstone_id',new.tombstone_id)
    from world_structure_invalidation i
   where i.tombstone_id=new.tombstone_id
  on conflict do nothing;
  return new;
end $fn$;

create trigger tg_world_structure_invalidate_on_tombstone
  after insert on tombstone
  for each row execute function tg_world_structure_invalidate_on_tombstone();

do $$
declare
  t text;
begin
  foreach t in array array[
    'world_structure_snapshot','world_structure_state','world_structure_preview',
    'world_structure_snapshot_region','world_structure_element_identity',
    'world_structure_snapshot_element','world_structure_dependency',
    'world_structure_placement_migration','world_structure_invalidation',
    'world_structure_audit_event'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy ws_isolation on %I using (workspace_id = current_workspace()) '
      'with check (workspace_id = current_workspace())', t);
  end loop;
end $$;

create index world_structure_history_idx
  on world_structure_snapshot (workspace_id,world_id,revision desc);
create index world_structure_preview_open_idx
  on world_structure_preview (workspace_id,world_id,created_at) where status='open';
create index world_structure_dependency_ref_idx
  on world_structure_dependency (workspace_id,dependency_kind,dependency_ref,snapshot_id);
create index world_structure_invalidation_snapshot_idx
  on world_structure_invalidation (workspace_id,world_id,snapshot_id,invalidated_at);

commit;

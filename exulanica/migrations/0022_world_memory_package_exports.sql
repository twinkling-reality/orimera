-- 0022_world_memory_package_exports.sql
-- The package itself is independently verifiable and intentionally lives outside PostgreSQL.
-- This table is the append-only receipt that says which protected snapshot the projector read,
-- which root it signed, and which explicit export policy omitted private payloads.

begin;

select pg_advisory_xact_lock(119622309);

create table world_package_export (
  export_id                     uuid primary key,
  workspace_id                  uuid not null,
  world_id                      text not null check (length(world_id) between 1 and 200),
  profile_version               text not null check (profile_version = 'orimera-wmp-1.0'),
  merkle_root_sha256            text not null check (merkle_root_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256               text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  parent_merkle_root_sha256     text check (parent_merkle_root_sha256 ~ '^[0-9a-f]{64}$'),
  structure_snapshot_id         uuid,
  style_version_id              uuid,
  interaction_policy_version_id uuid,
  signature_algorithm           text not null check (signature_algorithm = 'Ed25519'),
  signing_public_key_sha256      text not null
                                    check (signing_public_key_sha256 ~ '^[0-9a-f]{64}$'),
  export_policy                 jsonb not null check (jsonb_typeof(export_policy) = 'object'),
  actor                         uuid not null,
  exported_at                   timestamptz not null default now(),
  unique (workspace_id, export_id),
  foreign key (workspace_id, world_id, structure_snapshot_id)
    references world_structure_snapshot(workspace_id, world_id, snapshot_id),
  foreign key (workspace_id, world_id, style_version_id)
    references world_style_version(workspace_id, world_id, version_id),
  foreign key (workspace_id, world_id, interaction_policy_version_id)
    references world_interaction_policy_version(workspace_id, world_id, version_id)
);

create function tg_world_package_export_append_only() returns trigger language plpgsql as $fn$
begin
  raise exception 'world_package_export is append-only'
    using errcode = 'integrity_constraint_violation';
end $fn$;

create trigger tg_world_package_export_append_only
  before update or delete on world_package_export
  for each row execute function tg_world_package_export_append_only();

alter table world_package_export enable row level security;
alter table world_package_export force row level security;
create policy ws_isolation on world_package_export
  using (workspace_id = current_workspace())
  with check (workspace_id = current_workspace());

create index world_package_export_history_idx
  on world_package_export(workspace_id, world_id, exported_at desc, export_id);
create index world_package_export_root_idx
  on world_package_export(workspace_id, merkle_root_sha256);

commit;

-- 0028_exulanica_namespace.sql
-- Pre-release cutover. ADR-0011 withdraws the Orimera GUC and WMP profile
-- before any external release. Migration 0001 and 0022 are not rewritten.

begin;

select pg_advisory_xact_lock(119622309);

create or replace function current_workspace() returns uuid
language sql stable as $fn$
  select nullif(current_setting('exulanica.workspace_id', true), '')::uuid;
$fn$;

alter table world_package_export
  drop constraint world_package_export_profile_version_check;

alter table world_package_export
  add constraint world_package_export_profile_version_check
  check (profile_version = 'exulanica-wmp-1.0');

commit;

-- 0025_a_rung_over_a_set_of_photographs.sql
-- ADR-0009 D9. A reconstruction scene earns a rung as a set, not as a reduction over the
-- individual photographs' rungs.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- `reconstruction_rung_is` carries `valid_fraction`, whose meaning is the fraction of one frame
-- that was placed. A scene has no honest value for that field: a mean, a minimum and a mean over
-- registered members answer different questions. This second predicate therefore records the
-- set-level measurement that exists today: which members registered, expressed by the support
-- spans, and the size of the complete set.
--
-- `reasons` is an array because the missing rung-1 and rung-2 measurements are separate facts.
-- Its schema deliberately declares no `items`: migration 0014 does not implement that keyword,
-- so claiming an element rule here would either be refused at seed time or would state a rule
-- the database cannot enforce.
--
-- This migration also closes a write-guard hole. Support spans name only registered members. A
-- deleted unregistered member therefore does not reach `tombstone_blocks_any_span`, even though
-- a rung over eight photographs is no longer a claim about the seven that remain. Scene subjects
-- ask `tombstone_blocks_scene` directly. The branch is nested because SQL does not promise that
-- a boolean expression avoids the UUID cast for other subject types. The older entity branch has
-- that latent shape already; changing it is outside this decision.

begin;

select pg_advisory_xact_lock(119622309);

insert into predicate (key, value_schema, functional, allows_kind, writes_a_name) values
  ('reconstruction_scene_rung_is',
   '{"type":"object","required":["rung","reasons","member_count"],
     "properties":{
       "rung":{"type":"integer","minimum":1,"maximum":4},
       "reasons":{"type":"array"},
       "member_count":{"type":"integer","minimum":1}}}',
   true,
   '{inference}',
   false)
on conflict (key) do nothing;

create or replace function tg_tombstone_guard_assertion() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if tombstone_blocks_any_span(new.workspace_id, new.support_span_ids) then
    perform tombstone_refuse('assertion');
  end if;
  if new.subject_ref->>'type' = 'entity'
     and tombstone_blocks_entity(new.workspace_id, (new.subject_ref->>'id')::uuid) then
    perform tombstone_refuse('assertion');
  end if;
  if new.subject_ref->>'type' = 'scene' then
    if tombstone_blocks_scene(new.workspace_id, (new.subject_ref->>'id')::uuid) then
      perform tombstone_refuse('assertion');
    end if;
  end if;
  if exists (select 1 from tombstone t
              where t.workspace_id = new.workspace_id
                and t.effective_at <= now()
                and t.scope = 'workspace') then
    perform tombstone_refuse('assertion');
  end if;
  return new;
end $fn$;

commit;

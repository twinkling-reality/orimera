-- 0011_no_derivative_of_tombstoned_bytes.sql
-- R7. A tombstone racing mid-pipeline left a fresh render of the deleted photograph on disk.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- R7 as recorded: "`_rendition` and `persist_artifact` consult no tombstone. Racing a deletion
-- into the window between intake commit and the rendition stage leaves three objects committed,
-- including a fresh 768px render of the tombstoned photograph. The run is correctly cancelled and
-- nothing is resurrected, so this is not defect 4, but the schema's `purge_job` table has no
-- implementation and nothing sweeps them."
--
-- Two separate things are in that sentence and only one of them is the leak.
--
--   THE LEAK is that a derivative could be WRITTEN for bytes already tombstoned. Nine tables
--   carry a tombstone guard and `artifact` is not one of them, so the pipeline's next stage
--   committed a rendition of a photograph the user had just deleted. This migration closes that:
--   after it, no derivative of tombstoned bytes can be created at all, and the whole class of
--   "a stage that ran anyway" stops existing.
--
--   THE CLEANUP is what to do about derivatives written BEFORE the tombstone arrived. That is the
--   `purge_job` queue and a worker to drain it, and it is a larger piece with its own role, its
--   own concurrency and its own failure modes. It is designed and it is NOT in this file. The
--   defect register says so and says what remains.
--
-- The guard has to be at the data layer rather than in the pipeline for the reason 0001 already
-- gives about every other guard: the object store is not in the database transaction, so a
-- refusal has to arrive before the commit whose rollback is the only thing that can undo the
-- write. `committed_writes` flushes bytes only after the transaction commits, so a trigger that
-- refuses the artifact row refuses the bytes with it.

begin;

select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. May a derivative of these bytes be created right now?
--
-- A different question from `tombstone_blocks_span`, and the difference is the interval branch.
-- Section 6.4 says an artifact overlapping a REDACTED INTERVAL is marked `needs_repair` rather
-- than refused: a redaction removes a moment, not a photograph, and refusing the whole derivative
-- would delete more than the user asked to delete. So there is no interval branch here, and its
-- absence is the decision rather than an oversight.
--
-- VOLATILE for the same reason every other tombstone predicate is: a stable function reuses the
-- statement snapshot and would not see a tombstone that commits while this insert is running.
-- `clock_timestamp()` and not `now()`, which is R13: `now()` is the transaction timestamp, so a
-- tombstone committed after this transaction began carries a later `effective_at` and would be
-- filtered out by the guard written to catch it.
create or replace function tombstone_blocks_derivative(p_workspace uuid, p_blob bytea)
returns boolean
language sql volatile as $fn$
  select exists (
    select 1
      from tombstone t
      left join capture c on c.capture_id = t.capture_id
     where t.workspace_id = p_workspace
       and t.effective_at <= clock_timestamp()
       and (
             t.scope = 'workspace'
          -- An explicit "never let this content back in" covers everything derived from it.
          or (t.blocklist_hash and c.blob_sha256 = p_blob)
          -- A capture tombstone releases once some live capture claims the bytes again, exactly
          -- as `tombstone_blocks_span` does, so a deliberate re-import is not blocked forever.
          or (t.scope = 'capture'
              and c.blob_sha256 = p_blob
              and not exists (select 1 from capture live
                               where live.workspace_id = p_workspace
                                 and live.blob_sha256  = p_blob
                                 and live.deleted_at is null))
       ));
$fn$;

comment on function tombstone_blocks_derivative(uuid, bytea) is
  'May a derivative of these bytes be created now. No interval branch: section 6.4 marks an '
  'artifact overlapping a redacted interval needs_repair rather than refusing it, because a '
  'redaction removes a moment and not a photograph.';

create or replace function tg_tombstone_guard_artifact() returns trigger
language plpgsql as $fn$
begin
  -- Every guard that reads a table under FORCE row-level security asserts the workspace context
  -- first, because a session that never declared one would see no tombstone and this would fail
  -- OPEN in the one place where failing open means writing a derivative of deleted content.
  perform assert_workspace_context(new.workspace_id);
  if tombstone_blocks_derivative(new.workspace_id, new.source_blob_sha256) then
    perform tombstone_refuse('artifact');
  end if;
  return new;
end $fn$;

create trigger tg_guard_artifact
  before insert on artifact
  for each row execute function tg_tombstone_guard_artifact();

-- --------------------------------------------------------------------------------------------
-- 2. `text_chunk` had no guard either, and section 6.4 says a redacted chunk is deleted and not
--    hidden. It carries `span_id` rather than a track and an interval, so it takes the same
--    span-based predicate `occurrence` and `assertion` already use.
--
-- Nothing writes `text_chunk` today. The guard is added now rather than when the first writer
-- appears, because the pattern this repository keeps finding is a rule that was going to be added
-- later and a table that quietly filled up first.
create or replace function tg_tombstone_guard_text_chunk() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if tombstone_blocks_any_span(new.workspace_id, array[new.span_id]) then
    perform tombstone_refuse('text_chunk');
  end if;
  return new;
end $fn$;

create trigger tg_guard_text_chunk
  before insert on text_chunk
  for each row execute function tg_tombstone_guard_text_chunk();

commit;

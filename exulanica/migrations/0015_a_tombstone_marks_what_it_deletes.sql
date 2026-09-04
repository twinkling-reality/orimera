-- 0015_a_tombstone_marks_what_it_deletes.sql
-- Two defects in 0013, both found by adversarial review and both measured.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- ---------------------------------------------------------------------------------------------
-- DEFECT 1. NOTHING IN THIS CODEBASE EVER SET `capture.deleted_at`, so the purger deferred every
-- job for ever through the product's own path.
--
-- `purge_releases_bytes` decides liveness from `capture.deleted_at`. `insert_tombstone` inserted
-- a tombstone row and nothing else, and a grep over `orimera/` for a writer of that column found
-- none. Measured, using only what the product exposes, one capture and two derivatives:
--
--     queued: 3 jobs
--     drain:  0 destroyed, 3 skipped, "something live still holds these bytes"
--     objects still on disk: 3        purge_completed_at: null
--
-- **And the test suite passed**, because its fixture ran `update capture set deleted_at = now()`
-- before writing the tombstone: the helper supplied the production step the shipping code did
-- not have. That is a test passing for the wrong reason, and R18 was verified against a flow
-- that did not exist.
--
-- The fix is a trigger rather than a line in `insert_tombstone`, for the reason every other
-- guard in this schema is a trigger: `insert_tombstone` is not the only way a row can reach
-- `tombstone`, and a cascade that depends on one call site is a cascade that stops happening the
-- day somebody writes a second one. It also makes the soft delete and the purge enqueue
-- consistent by construction, because they are now the same statement's work.
--
-- `docs/domain-and-evidence-model.md` section 6.4 already specifies this: a capture tombstone
-- soft-marks the capture. It was specified and not implemented.
--
-- DEFECT 2. A WORKSPACE TOMBSTONE WAS RECORDED COMPLETE WITH THE WORKSPACE'S BYTES ON DISK.
--
-- The enqueue is a snapshot taken in the tombstone's transaction, and `tombstone_purge_is_complete`
-- inspected only the rows that snapshot named. For `capture` scope the object set is closed at
-- insert time. For `workspace` scope it is not: a capture inserted afterwards is accepted by the
-- database, and its bytes were never enqueued. Measured:
--
--     a later capture was accepted: true      a later derivative was refused: yes (0011 working)
--     jobs: [blob queued]                     drain: 1 destroyed
--     objects left on disk: 2                 purge_completed_at set: TRUE
--
-- 0013's comment that "a tombstone with no jobs is complete" is right for `entity` and
-- `assertion` scope and wrong for `workspace`, which is what this corrects.
-- ---------------------------------------------------------------------------------------------

begin;

select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. A tombstone marks what it deletes, in its own transaction.
-- --------------------------------------------------------------------------------------------

create or replace function tg_tombstone_enqueues_its_purge() returns trigger
language plpgsql as $fn$
begin
  if new.scope not in ('capture', 'workspace') then
    return new;
  end if;

  -- FIRST, and in the same transaction as the tombstone that asked for it. `deleted_at` is what
  -- every reader means by "the user removed this", and it is what `purge_releases_bytes` asks.
  -- A tombstone without it is a deletion that blocks new writes and releases nothing.
  update capture c
     set deleted_at = coalesce(c.deleted_at, new.effective_at)
   where c.workspace_id = new.workspace_id
     and c.deleted_at is null
     and (new.scope = 'workspace' or c.capture_id = new.capture_id);

  insert into purge_job (tombstone_id, workspace_id, target_kind, target_ref)
  select new.tombstone_id, new.workspace_id, 'blob', encode(c.blob_sha256, 'hex')
    from capture c
   where c.workspace_id = new.workspace_id
     and (new.scope = 'workspace' or c.capture_id = new.capture_id)
  on conflict (tombstone_id, target_kind, target_ref) do nothing;

  -- Everything derived from them. `distinct` because two artifacts of one capture can share a
  -- content hash, and one object is one job. `content_sha256 is not null` because an artifact
  -- whose content was never recorded has no object to destroy, and enqueueing it would queue a
  -- target `purge_releases_bytes` is required to refuse.
  insert into purge_job (tombstone_id, workspace_id, target_kind, target_ref)
  select distinct new.tombstone_id, new.workspace_id, 'artifact',
         encode(a.content_sha256, 'hex')
    from artifact a
    join capture c on c.blob_sha256 = a.source_blob_sha256
                  and c.workspace_id = a.workspace_id
   where a.workspace_id = new.workspace_id
     and a.content_sha256 is not null
     and a.purged_at is null
     and (new.scope = 'workspace' or c.capture_id = new.capture_id)
  on conflict (tombstone_id, target_kind, target_ref) do nothing;

  return new;
end $fn$;

-- --------------------------------------------------------------------------------------------
-- 2. A workspace tombstone is complete when the WORKSPACE has no bytes left, not when its
--    snapshot is drained.
-- --------------------------------------------------------------------------------------------

create or replace function tombstone_purge_is_complete(p_tombstone uuid) returns boolean
language plpgsql volatile as $fn$
declare
  v_scope     text;
  v_workspace uuid;
begin
  select t.scope::text, t.workspace_id into v_scope, v_workspace
    from tombstone t where t.tombstone_id = p_tombstone;
  if v_scope is null then
    return false;
  end if;

  -- Every job this tombstone enqueued must be done AND the row it named must be marked purged,
  -- so a job that left the queue without the bytes going away cannot satisfy this. Not "is the
  -- queue quiet": that is a statement about the queue.
  if exists (
    select 1 from purge_job pj
     where pj.tombstone_id = p_tombstone
       and (pj.state <> 'done'
            or (pj.target_kind = 'blob' and exists (
                  select 1 from blob b
                   where b.blob_sha256 = decode(pj.target_ref, 'hex')
                     and b.purged_at is null))
            or (pj.target_kind = 'artifact' and exists (
                  select 1 from artifact a
                   where a.workspace_id = pj.workspace_id
                     and a.content_sha256 = decode(pj.target_ref, 'hex')
                     and a.purged_at is null))))
  then
    return false;
  end if;

  -- And for a workspace tombstone, the snapshot is not the question. A capture inserted after
  -- the tombstone is accepted by the database and its bytes were never enqueued, so completion
  -- has to ask about the workspace rather than about the job list. Measured in this file's
  -- header: without this the tombstone claimed the workspace was purged with two objects on
  -- disk.
  if v_scope = 'workspace' then
    return not exists (
      select 1 from capture c join blob b on b.blob_sha256 = c.blob_sha256
       where c.workspace_id = v_workspace and b.purged_at is null)
       and not exists (
      select 1 from artifact a
       where a.workspace_id = v_workspace and a.content_sha256 is not null
         and a.purged_at is null);
  end if;
  return true;
end $fn$;

comment on function tombstone_purge_is_complete(uuid) is
  'Did the deletion happen, rather than did the queue go quiet. For workspace scope the question '
  'is about the workspace and not about the enqueue snapshot: see migration 0015 defect 2.';

commit;

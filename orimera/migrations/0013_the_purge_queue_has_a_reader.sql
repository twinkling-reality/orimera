-- 0013_the_purge_queue_has_a_reader.sql
-- R18. Derivatives written before a tombstone arrived are still on disk. This is the cleanup.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- 0011 closed the leak: after it, no derivative of tombstoned bytes can be created at all. What
-- it deliberately did not do is remove the ones written BEFORE the tombstone arrived. `purge_job`
-- has existed since 0001 with no reader and no writer, and `tombstone.purge_completed_at` has
-- been written by nothing. This gives the first a writer, a claimable shape and predicates that
-- do not fail open, and makes the second mean what it says.
--
-- SEVEN corrections a review measured against the design, each of which is in what follows.
-- Six were on the defect register. The seventh was found here, by running the design against a
-- real database as a real role, and it is the one that would have destroyed another tenant's
-- photographs.
--
-- ---------------------------------------------------------------------------------------------
-- CORRECTION 1. `purge_lock_object(NULL)` took NO lock and returned NULL.
--
-- `artifact.content_sha256` is nullable, so the lock was absent on exactly the rows it was added
-- for. Measured: `select pg_advisory_xact_lock(hashtextextended(null, 0))` returns NULL and
-- `pg_locks` shows nothing held. It now raises. A target nobody can name is not a target this
-- may lock, and continuing without the lock is worse than stopping.
--
-- CORRECTION 2. `purge_releases_bytes(NULL)` returned TRUE, so the destroy predicate FAILED OPEN.
--
-- Both `not exists` clauses are vacuously true because `= NULL` is never true. Measured against
-- this schema before the fix: `select purge_releases_bytes(null)` -> `t`, which reads as
-- "destroy these bytes" for bytes nobody named. Section 6.3 already names this shape for the
-- interval guard. It now raises, for the same reason as correction 1.
--
-- CORRECTION 3. `skipped` was terminal, so `purge_completed_at` was set while bytes were on disk.
--
-- A job skipped because something still held its bytes could not be re-enqueued, because the
-- unique constraint refuses a second row for the same target, and it was excluded from the
-- completion check. So the tombstone was recorded as purged with the photograph still there.
-- `skipped` is now a state the claim query picks up again, and `attempted_at` is what stops a
-- permanently-held blob spinning: a skipped job is retried after the others, in order of when it
-- was last tried, rather than immediately and for ever.
--
-- CORRECTION 4. The completion check must ask whether the DELETION happened.
--
-- "Every job for this tombstone has left the queue" is a statement about the queue.
-- `tombstone_purge_is_complete` asks the other question: for every job, is the row it named now
-- marked purged. A job that finished without the bytes going away cannot satisfy it.
--
-- CORRECTION 5. The reclaim of a dead worker's `running` row cannot work as designed, so there
-- is none. The claim query filters on state and the queue index is partial on the same, so a
-- stranded row is invisible to every query here. Half a reclaim reads as coverage. R20 on the
-- defect register says what a real one needs; it is the same gap the derivative queue has and
-- it has the same answer.
--
-- CORRECTION 6, CORRECTED AGAIN BY MEASUREMENT. "DELETE-proof" is an invariant 10 overclaim and
-- the wording is "append-only by policy". The register said `truncate tombstone cascade`
-- succeeds with a TRUNCATE trigger enabled. Measured here, it does not: the cascade notice is
-- printed, the BEFORE TRUNCATE trigger raises, and the whole statement rolls back. What IS true,
-- and is the hole worth closing, is that `truncate purge_job cascade` succeeds on its own,
-- because the trigger was only ever specified for `tombstone`. Both tables carry one now. The
-- owner can still disable either, and no trigger can stop that, which is why the word is policy.
--
-- CORRECTION 7, NEW, and the one that mattered most. THE PREDICATE COULD NOT SEE THE OTHER
-- TENANT.
--
-- `blob` is not workspace-scoped. 0001 says so in a comment and names reference counting as the
-- eventual fix: two workspaces that ingest the same photograph share one row and one object.
-- `capture` IS under FORCE row-level security, so a session scoped to one workspace cannot see
-- another's captures, and `purge_releases_bytes` is only as truthful as what the caller can see.
--
-- Measured, on a probe database, connected as `orimera_app` rather than as the owner, because
-- the owner is a superuser and a superuser bypasses row-level security entirely, which is the
-- trap `orimera/db/roles.py` was written for: workspace A deletes its capture, workspace B still
-- holds a LIVE capture of the same bytes, and the predicate answers TRUE. Destroying them there
-- breaks every citation B has, and nothing reports it.
--
-- The fix is not in this file, because roles are cluster-global objects and this schema creates
-- none. `orimera/db/roles.py::provision_purge_role` creates `orimera_purge` with a permissive
-- SELECT policy on `capture` and `artifact` and column grants narrow enough that it reads
-- identifiers, content hashes and deletion markers and nothing else. Its UPDATE is still
-- filtered by `ws_isolation`, so it reads across tenants and writes within one. Measured after:
-- the same question answers FALSE, and the runtime role's view is unchanged at one capture.
-- ---------------------------------------------------------------------------------------------
--
-- WHAT IS OUT OF SCOPE, said rather than left to be inferred. This purges the object store:
-- original bytes and derivative bytes, for `capture` and `workspace` tombstones, which are the
-- two scopes that name whole byte sequences. It does not purge `embedding` or `text_chunk` rows,
-- which are rows rather than objects and whose physical residency inside an ANN index is
-- experiment X-11 and unsettled. It does not act on `interval` scope: section 6.4 marks an
-- artifact overlapping a redacted interval `needs_repair` rather than destroying it, because a
-- redaction removes a moment and not a photograph. `purge_job.target_kind` keeps its four values
-- so the day those are implemented the column does not move.

begin;

select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. `skipped` is a state, and it is not terminal. Correction 3.
-- --------------------------------------------------------------------------------------------

alter table purge_job drop constraint purge_job_state_check;
alter table purge_job add constraint purge_job_state_check
  check (state in ('queued', 'running', 'skipped', 'done', 'failed'));

-- When the last attempt was made, which is what stops a permanently-held blob spinning. NULL
-- means never attempted, and `nulls first` in the index below is what puts a fresh job ahead of
-- one that has already been tried and skipped.
alter table purge_job add column attempted_at timestamptz;

comment on column purge_job.attempted_at is
  'When this job was last claimed. NULL means never. Ordering by it puts a never-tried job '
  'ahead of one that has already been skipped, so a blob something else still holds does not '
  'starve the rest of the queue.';

-- The old index was partial on state = 'queued' alone, which is what made `skipped` terminal:
-- nothing could see a skipped row, so nothing could re-claim it.
drop index if exists purge_job_queue_idx;
create index purge_job_queue_idx
  on purge_job (state, attempted_at nulls first, created_at)
  where state in ('queued', 'skipped');

-- --------------------------------------------------------------------------------------------
-- 2. The two predicates, neither of which may fail open. Corrections 1 and 2.
-- --------------------------------------------------------------------------------------------

create or replace function purge_lock_object(p_ref text) returns bigint
language plpgsql volatile as $fn$
declare
  v_key bigint;
begin
  -- Raise rather than return NULL. `pg_advisory_xact_lock(NULL)` takes no lock and returns
  -- NULL, so a caller that checked nothing carried on unserialised, holding what looked like a
  -- lock. Two workers then destroy the same object and the second reports an error for a file
  -- the first correctly removed.
  if p_ref is null then
    raise exception 'purge_lock_object was called with no target'
      using errcode = 'null_value_not_allowed',
            hint = 'A target nobody can name is not a target this can serialise access to.';
  end if;
  v_key := hashtextextended(p_ref, 0);
  perform pg_advisory_xact_lock(v_key);
  return v_key;
end $fn$;

comment on function purge_lock_object(text) is
  'Serialise two purgers over one stored object. Raises on NULL rather than silently taking no '
  'lock: see correction 1 in migration 0013.';

create or replace function purge_releases_bytes(p_bytes bytea) returns boolean
language plpgsql volatile as $fn$
begin
  -- Raise rather than return TRUE. Both clauses below are vacuously true for NULL, because
  -- `= NULL` is never true, so the destroy predicate failed OPEN on exactly the rows whose
  -- content hash was never recorded.
  if p_bytes is null then
    raise exception 'purge_releases_bytes was called with no content hash'
      using errcode = 'null_value_not_allowed',
            hint = 'Bytes nobody can name are bytes this cannot decide about. Destroying them '
                   'because the question was unanswerable is the wrong direction to fail.';
  end if;
  -- VOLATILE, like every other tombstone predicate, so it takes a fresh snapshot rather than
  -- reusing the statement's: a capture re-imported while this runs must be seen.
  --
  -- HOW MUCH THIS SEES IS THE CALLER'S PRIVILEGE, NOT THIS FUNCTION'S. `capture` and `artifact`
  -- are under FORCE row-level security. Called by a session that can see one workspace, this
  -- answers about one workspace, and `blob` is shared, so that answer is wrong in the direction
  -- that destroys somebody else's photograph. Correction 7 in this file's header, and
  -- `provision_purge_role` is what makes the caller able to see the whole question.
  --
  -- THE ARTIFACT CLAUSE JOINS ITS SOURCE CAPTURE, AND WITHOUT THAT JOIN IT REFUSES ITSELF. An
  -- artifact row names an object and holds it until the row is marked purged; the row is marked
  -- purged only after the object is destroyed, because the store is not in this transaction and
  -- the other order leaves a row that lies. So "is any unpurged artifact holding these bytes"
  -- is always true of the very artifact being purged, and measured that way the purger destroyed
  -- the original and deferred every derivative of it for ever.
  --
  -- What survives is the question. An artifact derived from a LIVE capture is a reason to keep
  -- the bytes. One derived from a deleted capture is itself doomed and is no reason for
  -- anything. An artifact whose source capture has no row at all does not block either, and
  -- cannot be a citation: invariant 2 says reconstruction is never evidence, and an
  -- `evidence_span` references `blob`.
  return not exists (select 1 from capture c
                      where c.blob_sha256 = p_bytes and c.deleted_at is null)
     and not exists (select 1 from artifact a
                      join capture c on c.blob_sha256 = a.source_blob_sha256
                                    and c.workspace_id = a.workspace_id
                      where a.content_sha256 = p_bytes
                        and a.purged_at is null
                        and c.deleted_at is null);
end $fn$;

comment on function purge_releases_bytes(bytea) is
  'May these exact bytes be destroyed: no live capture and no unpurged artifact holds them. '
  'Raises on NULL rather than failing open. Only as truthful as the caller can see; the purge '
  'role is granted a cross-workspace read for exactly this question.';

-- --------------------------------------------------------------------------------------------
-- 3. Completion asks whether the deletion happened. Correction 4.
-- --------------------------------------------------------------------------------------------

create or replace function tombstone_purge_is_complete(p_tombstone uuid) returns boolean
language sql volatile as $fn$
  -- Not "is the queue quiet". Every job must be done AND the row it named must be marked
  -- purged, so a job that left the queue without the bytes going away cannot satisfy this.
  --
  -- A tombstone with no jobs at all is complete, and that is correct rather than a hole: the
  -- enqueue runs in the tombstone's own transaction, so "no jobs" means "nothing to purge",
  -- which is the ordinary case for an entity or assertion tombstone.
  select not exists (
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
                     and a.purged_at is null))));
$fn$;

comment on function tombstone_purge_is_complete(uuid) is
  'Did the deletion happen, rather than did the queue go quiet. See correction 4 in 0013.';

-- --------------------------------------------------------------------------------------------
-- 4. Append-only by policy, and a TRUNCATE trigger anyway. Correction 6.
-- --------------------------------------------------------------------------------------------
--
-- NOT tamper-proof, not WORM, not immutable. The table owner can `alter table ... disable
-- trigger` and this stops nothing, which was measured and is why the word is policy. What it
-- does stop is the ordinary accident: a `truncate ... cascade` typed at the wrong prompt.
-- Measured before it existed: `truncate purge_job cascade` succeeded, which loses the record of
-- what has not yet been destroyed while every tombstone still says it was requested.

create or replace function tg_refuse_truncate() returns trigger
language plpgsql as $fn$
begin
  raise exception '% is append-only by policy and is not truncated', tg_table_name
    using errcode = 'insufficient_privilege',
          hint = 'Deletion in this system is a tombstone plus a purge job plus the separately '
                 'authorised purger. Removing the record of that is not one of its steps.';
end $fn$;

create trigger tg_tombstone_no_truncate before truncate on tombstone
  for each statement execute function tg_refuse_truncate();

create trigger tg_purge_job_no_truncate before truncate on purge_job
  for each statement execute function tg_refuse_truncate();

-- --------------------------------------------------------------------------------------------
-- 5. The queue gets a writer, in the tombstone's own transaction.
-- --------------------------------------------------------------------------------------------
--
-- A trigger rather than application code, because a caller can forget and a trigger cannot. It
-- is the same reason every other guard in this schema is a trigger: `insert_tombstone` is not
-- the only way a row reaches this table, and a purge that depends on one call site is a purge
-- that stops happening the day somebody writes a second one.

create or replace function tg_tombstone_enqueues_its_purge() returns trigger
language plpgsql as $fn$
begin
  -- `capture` and `workspace` name whole byte sequences. `interval` marks artifacts
  -- `needs_repair` rather than destroying them, `entity` removes a name and links and no bytes,
  -- and `assertion` removes a claim. See this file's header on scope.
  if new.scope not in ('capture', 'workspace') then
    return new;
  end if;

  -- The originals.
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

create trigger tg_tombstone_enqueues_its_purge after insert on tombstone
  for each row execute function tg_tombstone_enqueues_its_purge();

commit;

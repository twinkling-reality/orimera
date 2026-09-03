-- 0024_a_scene_is_a_subject_deletion_can_reach.sql
-- ADR-0009 D9. A fact about a set needs a subject, and deletion has to reach it.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- Every artifact until now is keyed to exactly one source blob, and that is what the purge
-- cascade and the export projector join on. A pose receipt, a splat and a placement record are
-- facts about N photographs and have no home in that scheme. This gives them one.
--
-- THE REDUCTION INVERTS, AND THAT IS THE WHOLE OF THIS FILE. For an artifact of one photograph
-- the question is "does any live capture hold these bytes", an OR over the captures sharing a
-- blob: a photograph imported twice is one artifact and two captures, and deleting one of them
-- withdraws nothing. `purge_releases_bytes` and `orimera/graph/geometry.py` both read that way
-- and both are right to. For a fact about N photographs the question is the opposite one.
-- D9: "a tombstone path that reaches a scene artifact through any of its members". Deleting ONE
-- of eight withdraws the receipt, because a receipt over eight photographs is not a claim about
-- the seven that are left. A test that only deleted every member would pass on either predicate,
-- which is why the no-ship rule in D9 says one of N.
--
-- Reading order: the scene and its members, the subject column on `artifact`, the predicate, the
-- write guard, the purge queue, then row-level security.
--
-- WHY THIS IS NOT A NEW SHAPE. Migration 0020 already built it once, for a different subject:
-- `world_structure_dependency` is an explicit many-to-many onto `capture`, guarded on insert by
-- `tg_world_structure_dependency_live` and reached on deletion by
-- `tg_world_structure_invalidate_on_tombstone`, an `after insert on tombstone` that finds a
-- snapshot through ANY dependency row. This file is deliberately the same shape, so that the two
-- read as one rule about composite subjects rather than as two inventions.
--
-- WHAT THIS DOES NOT DO, said rather than left to be inferred. It adds no `tombstone_scope`
-- value and it does not reach entity scope. Deleting a person is not deleting the photograph,
-- which `docs/domain-and-evidence-model.md` section 6.4 lists among the consequences that "must
-- not be softened", and a scene is made of photographs. The entity cascade that section promises
-- and does not run is recorded there under CORRECTED and is not this file's gap to close. It
-- also writes no producer: nothing in this repository creates a scene or a scene artifact yet,
-- so D9's rule that no scene-level artifact ships before the deletion test is satisfied by there
-- being nothing to ship.

begin;

select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. The scene, and its members.
-- --------------------------------------------------------------------------------------------

-- A composite foreign key needs a unique key that carries the workspace. `capture_id` is already
-- the primary key, so this looks redundant and is not: 0017 added the same thing to
-- `evidence_span` and recorded why, that "a plain span_id foreign key would prove existence
-- globally and would not prove authorisation". A member row that could name another workspace's
-- photograph is a scene that could be deleted by the wrong person's deletion.
alter table capture add constraint capture_workspace_capture_uniq
  unique (workspace_id, capture_id);

-- The set a reconstruction was run over. `reconstruction_scene` rather than `scene`, because
-- this schema already spends that word: a `scene_group` is a `derived_artifact` holding a
-- time-and-space clustering proposal, and D9's own reduction paragraph turns on the two being
-- different subjects. Worst-first is right for a group of panels, because a hole is a hole, and
-- wrong for a scene, because "four unregistered photographs are not holes in a corridor, they
-- are photographs that open as photographs".
create table reconstruction_scene (
  -- DETERMINISTIC: uuid_v5(namespace, the sorted member capture ids), like `artifact_id` and for
  -- the same reason. An artifact's identity key has to contain its subject, and a pose job's
  -- identity has to be computable before the job runs.
  --
  -- OVER CAPTURE IDS AND DELIBERATELY NOT OVER BLOB HASHES. Decision del-3 gives a re-imported
  -- photograph a NEW capture_id, so a set keyed on bytes would resolve a re-import to the same
  -- scene id and resurrect an identity a tombstone withdrew. Deletion is monotonic; keying on
  -- content would make it monotonic in one direction only. A capture id is a uuidv7 and is
  -- unique across workspaces, so the sorted set separates workspaces on its own and the key
  -- carries none, which is the arrangement `artifact_id` already has.
  scene_id      uuid primary key,
  workspace_id  uuid not null,
  -- The full digest the id is derived from, carried beside it as `params_digest` and
  -- `input_digest` are carried beside `artifact_id`: sixteen bytes name the scene and
  -- thirty-two bytes are what a receipt cites.
  member_digest bytea not null check (octet_length(member_digest) = 32),
  created_at    timestamptz not null default now(),
  unique (workspace_id, scene_id),
  unique (workspace_id, member_digest)
);

-- The explicit many-to-many D9 asks for, and a table rather than a `uuid[]` for two reasons.
-- `derived_artifact.source_ids` is the existing array precedent and nothing joins it, so no
-- cascade reaches through it. And a member carries a fact of its own that an array cannot hold:
-- whether it registered.
create table reconstruction_scene_member (
  workspace_id uuid not null,
  scene_id     uuid not null,
  capture_id   uuid not null,
  -- Presentation order within the scene, recorded rather than derived, because the order a job
  -- was given its frames in is an input to that job and not a property of the photographs.
  ordinal      int  not null check (ordinal >= 0),
  -- NULL until a receipt says, and NULL is not false. D4: "an unmeasured threshold is None, and
  -- None blocks the rung it guards". A member whose registration nobody has measured is not a
  -- registered member, so it contributes no support span to the scene rung and the rung refuses
  -- with a reason. The identity is the set the job was GIVEN, which is what makes the scene id
  -- computable before the job runs; registration is the outcome and belongs on the member.
  registered   boolean,
  primary key (workspace_id, scene_id, capture_id),
  foreign key (workspace_id, scene_id)
    references reconstruction_scene(workspace_id, scene_id),
  foreign key (workspace_id, capture_id)
    references capture(workspace_id, capture_id)
);

-- The enqueue trigger and the destroy predicate both ask "which scenes was this capture in",
-- which the primary key cannot answer because the capture is its last column.
create index reconstruction_scene_member_capture_idx
  on reconstruction_scene_member (workspace_id, capture_id, scene_id);

comment on column reconstruction_scene_member.registered is
  'Whether this member registered, from the receipt. NULL means nobody has measured it, which '
  'is not the same as false: an unmeasured member supports no scene-level claim.';

-- --------------------------------------------------------------------------------------------
-- 2. An artifact names one subject: a blob, or a scene, never both and never neither.
-- --------------------------------------------------------------------------------------------
--
-- `source_blob_sha256` was `not null`, and relaxing it is the one widening in this file. Every
-- reader of `artifact` can now receive a NULL there, and the check constraint is what keeps the
-- guarantee: a row still names exactly one subject, it is just no longer always the same kind of
-- subject. The two functions that reduce over the whole table rather than joining a capture are
-- corrected in section 5, because for those the widening fails OPEN and silence would be the
-- worst of the available outcomes.
--
-- The alternative, one artifact row per contributing capture all sharing a content digest, is
-- rejected in ADR-0009's own list: the row count becomes photographs times scene artifacts, and
-- a set with no identity has no subject for a scene rung claim.

alter table artifact add column scene_id uuid;
alter table artifact alter column source_blob_sha256 drop not null;

alter table artifact add constraint an_artifact_names_one_subject check (
  (source_blob_sha256 is not null) <> (scene_id is not null));

alter table artifact add constraint artifact_scene_is_in_its_own_workspace
  foreign key (workspace_id, scene_id) references reconstruction_scene(workspace_id, scene_id);

create index artifact_scene_idx on artifact (workspace_id, scene_id) where scene_id is not null;

comment on column artifact.scene_id is
  'The scene this artifact is a fact about, when it is a fact about a set rather than about one '
  'photograph. Exactly one of this and source_blob_sha256 is set: see 0024 section 2.';

-- `artifact_current` has no readers today, which is exactly why this is corrected now rather
-- than left for the first one. `distinct on` treats NULLs as equal, so with the widening above
-- every scene artifact of one stage in one workspace would collapse into a single row, and the
-- view would report that a workspace holds one pose receipt however many it holds. The column
-- list is unchanged; only the key it is distinct on moves.
create or replace view artifact_current as
  select distinct on (workspace_id, source_blob_sha256, scene_id, stage_key) *
    from artifact
   where superseded_by is null and purged_at is null
   order by workspace_id, source_blob_sha256, scene_id, stage_key, stage_version desc;

-- --------------------------------------------------------------------------------------------
-- 3. The predicate. One rule, in SQL, asked rather than re-implemented per reader.
-- --------------------------------------------------------------------------------------------

create or replace function tombstone_blocks_scene(p_workspace uuid, p_scene uuid)
returns boolean
-- VOLATILE, like every other tombstone predicate in this schema, so it takes a fresh snapshot
-- per call rather than reusing the statement's: a tombstone committing while an insert runs must
-- be seen. The cost is that it cannot be inlined, and at this write volume that is not a
-- consideration.
language sql volatile as $fn$
  select
    -- FAIL CLOSED ON AN EMPTY MEMBERSHIP, and this clause is not a formality. A scene with no
    -- member rows is either a scene being built, in which case its artifact must not be written
    -- yet, or a scene whose membership this session cannot see, because
    -- `reconstruction_scene_member` carries FORCE row-level security and a session that never
    -- set `orimera.workspace_id` reads it as empty. Answering "nothing blocks it" to a question
    -- this could not see the inputs of is the direction `_require_workspace_context` exists to
    -- prevent. The ordering discipline it forces is that members are inserted before the
    -- artifact that names their scene.
    not exists (select 1 from reconstruction_scene_member m
                 where m.workspace_id = p_workspace and m.scene_id = p_scene)
    or exists (
      select 1
        from reconstruction_scene_member m
        join capture c on c.capture_id = m.capture_id
       where m.workspace_id = p_workspace
         and m.scene_id = p_scene
         -- THE TOMBSTONE BRANCH IS THE LOAD-BEARING ONE, and it is the second rather than the
         -- first because the first is cheaper to evaluate. It covers what `deleted_at` cannot:
         -- an interval redaction over a member never sets that column at all, because migration
         -- 0015's trigger returns early for every scope but capture and workspace, and a still
         -- image's interval `[0, 1)` covers its whole frame. Without it a redaction would reach
         -- the photograph and not the corridor it is part of.
         --
         -- **`deleted_at` covers nothing the tombstone branch misses today**, and is here as
         -- defence in depth rather than as a second case: every writer of that column is
         -- 0015's trigger, which only ever sets it alongside a capture or workspace tombstone
         -- that the branch below already matches. It is stated this way rather than as "each
         -- covers what the other misses", which was the wrong claim, so that whoever adds a
         -- second writer of `deleted_at` finds this predicate already reading it.
         and (c.deleted_at is not null
              or tombstone_blocks_capture(p_workspace, m.capture_id)));
$fn$;

comment on function tombstone_blocks_scene(uuid, uuid) is
  'Does a deletion reach this scene through any of its members. The reduction is ANY and not '
  'ALL: a fact about eight photographs is withdrawn by the deletion of one. ADR-0009 D9.';

-- --------------------------------------------------------------------------------------------
-- 4. The write guard branches on the subject.
-- --------------------------------------------------------------------------------------------
--
-- `tg_tombstone_guard_artifact` arrived in 0011 asking `tombstone_blocks_derivative` of
-- `new.source_blob_sha256`. With a NULL there, every branch of that predicate except the
-- workspace one is dead, because `c.blob_sha256 = NULL` is never true, so a scene artifact over
-- tombstoned members would insert cleanly. Re-stated here in full, because a guard that reads
-- the wrong column for one kind of row is a guard with a hole rather than a guard with a gap.

create or replace function tg_tombstone_guard_artifact() returns trigger
language plpgsql as $fn$
begin
  -- Every guard that reads a table under FORCE row-level security asserts the workspace context
  -- first, because a session that never declared one would see no tombstone and this would fail
  -- OPEN in the one place where failing open means writing a derivative of deleted content.
  perform assert_workspace_context(new.workspace_id);
  if new.scene_id is not null then
    if tombstone_blocks_scene(new.workspace_id, new.scene_id) then
      perform tombstone_refuse('artifact');
    end if;
  elsif tombstone_blocks_derivative(new.workspace_id, new.source_blob_sha256) then
    perform tombstone_refuse('artifact');
  end if;
  return new;
end $fn$;

-- A member of a scene is a live photograph nobody has deleted, asserted at insert rather than
-- discovered at read. The same shape as `tg_world_structure_dependency_live` in 0020. The
-- composite foreign key already refuses another workspace's capture, so what is left here is
-- liveness and the tombstone.
create or replace function tg_reconstruction_scene_member_live() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if not exists (select 1 from capture c
                  where c.workspace_id = new.workspace_id
                    and c.capture_id = new.capture_id
                    and c.deleted_at is null) then
    raise exception 'a scene member names a photograph that is absent or deleted'
      using errcode = 'foreign_key_violation';
  end if;
  if tombstone_blocks_capture(new.workspace_id, new.capture_id) then
    perform tombstone_refuse('reconstruction_scene_member');
  end if;
  return new;
end $fn$;

create trigger tg_guard_reconstruction_scene_member
  before insert on reconstruction_scene_member
  for each row execute function tg_reconstruction_scene_member_live();

-- **A membership is append-only, and the guard above is worth nothing without this.** It fires
-- `before insert`, and the runtime role holds `select, insert, update` on every table, so
-- `update reconstruction_scene_member set capture_id = <a live one>` would re-point a member
-- away from the photograph that was deleted and un-withdraw a scene a tombstone had already
-- reached. Deletion is monotonic (del-1); a membership that can be edited afterwards is a
-- deletion that can be undone by an UPDATE, which is the one thing the whole cascade exists to
-- prevent. `world_structure_dependency` is append-only in 0020 for the same reason, and this is
-- the same trigger shape.
--
-- **So `registered` is written at insert and never updated**, which decides the writer's shape
-- rather than merely constraining it: a scene is recorded once the receipt exists, with the
-- identity, the members and their registration in one transaction. A producer that wanted to
-- record an attempt before knowing its outcome is recording a job, and `job` is where a job
-- lives. The alternative, a narrow lifecycle update permitting only `registered`, is what 0020
-- does for a preview's `status`; it is rejected here because a preview is a thing being edited
-- and a membership is a statement about what a completed computation was given.
--
-- KNOWN AND ACCEPTED: nothing in SQL checks that `member_digest` is the digest of the rows in
-- `reconstruction_scene_member`. Reproducing the framing in plpgsql would be a second writer of
-- one encoding, which is the defect ADR-0010 records as its sixth. What this trigger buys
-- instead is that the two cannot DRIFT: both are fixed at insert, so a mismatched pair is a row
-- no derivation will ever name rather than a row that changed its mind.
create function tg_reconstruction_scene_append_only() returns trigger
language plpgsql as $fn$
begin
  raise exception '% is append-only: a membership deletion can reach is not editable',
    tg_table_name
    using errcode = 'integrity_constraint_violation',
          hint = 'A scene is recorded once, with its members and their registration, in the '
                 'transaction that accepts the receipt.';
end $fn$;

do $$
declare
  t text;
begin
  foreach t in array array['reconstruction_scene', 'reconstruction_scene_member'] loop
    execute format(
      'create trigger %I before update or delete on %I '
      'for each row execute function tg_reconstruction_scene_append_only()',
      'tg_' || t || '_append_only', t);
  end loop;
end $$;

-- --------------------------------------------------------------------------------------------
-- 5. The purge queue reaches a scene artifact, and the destroy predicate does not fail open.
-- --------------------------------------------------------------------------------------------

-- Re-stated in full from 0015 with one insert added. The whole body is reproduced deliberately:
-- 0015's defect 1 was that nothing in this codebase ever set `capture.deleted_at`, so the purger
-- deferred every job for ever through the product's own path while the suite passed, because the
-- fixture supplied the production step the shipping code did not have. The `update capture` below
-- is that fix, and a re-statement that dropped it would reintroduce the whole of it silently.
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

  -- AND EVERY SCENE THIS CAPTURE WAS A MEMBER OF. The insert above cannot reach one: it finds
  -- artifacts by joining `capture` on `source_blob_sha256`, which a scene artifact does not
  -- have, so without this a pose receipt over eight photographs is never enqueued at all. Not a
  -- failure and not an error: zero rows, an empty queue, and `tombstone_purge_is_complete`
  -- answering true because a tombstone with no jobs is complete.
  --
  -- One member is enough, and that is the inversion. There is no clause here asking whether the
  -- scene's OTHER members survive, because a receipt over eight photographs is not a claim about
  -- the seven that are left.
  insert into purge_job (tombstone_id, workspace_id, target_kind, target_ref)
  select distinct new.tombstone_id, new.workspace_id, 'artifact',
         encode(a.content_sha256, 'hex')
    from artifact a
   where a.workspace_id = new.workspace_id
     and a.scene_id is not null
     and a.content_sha256 is not null
     and a.purged_at is null
     and (new.scope = 'workspace'
          or exists (select 1 from reconstruction_scene_member m
                      where m.workspace_id = new.workspace_id
                        and m.scene_id = a.scene_id
                        and m.capture_id = new.capture_id))
  on conflict (tombstone_id, target_kind, target_ref) do nothing;

  return new;
end $fn$;

-- Re-stated from 0013 with a third clause. Corrections 2 and 7 of that file are reproduced
-- verbatim in behaviour: it raises on NULL rather than answering "destroy these bytes", and it
-- is only as truthful as the caller can see, which is why `orimera/db/roles.py` grants the purge
-- role a cross-workspace read of the tables it asks about. `reconstruction_scene_member` is now
-- one of them.
create or replace function purge_releases_bytes(p_bytes bytea) returns boolean
language plpgsql volatile as $fn$
begin
  -- Raise rather than return TRUE. Every clause below is vacuously true for NULL, because
  -- `= NULL` is never true, so the destroy predicate failed OPEN on exactly the rows whose
  -- content hash was never recorded.
  if p_bytes is null then
    raise exception 'purge_releases_bytes was called with no content hash'
      using errcode = 'null_value_not_allowed',
            hint = 'Bytes nobody can name are bytes this cannot decide about. Destroying them '
                   'because the question was unanswerable is the wrong direction to fail.';
  end if;
  return not exists (select 1 from capture c
                      where c.blob_sha256 = p_bytes and c.deleted_at is null)
     -- An artifact derived from a LIVE capture is a reason to keep the bytes. One derived from a
     -- deleted capture is itself doomed and is no reason for anything. The join is what stops
     -- the predicate refusing the very artifact being purged, which was measured before it
     -- existed: the purger destroyed the original and deferred every derivative of it for ever.
     and not exists (select 1 from artifact a
                      join capture c on c.blob_sha256 = a.source_blob_sha256
                                    and c.workspace_id = a.workspace_id
                      where a.content_sha256 = p_bytes
                        and a.purged_at is null
                        and c.deleted_at is null)
     -- THE SCENE CLAUSE, AND WITHOUT IT THIS FAILS OPEN. A scene artifact has no
     -- `source_blob_sha256`, so the inner join above drops it out of the question entirely and
     -- the answer comes back TRUE: destroy a live pose receipt's bytes while every one of its
     -- members is live. That is the same shape as this function's own correction 2 and it is
     -- created by the widening in section 2 rather than fixed by it.
     --
     -- The inner `not exists` is the inversion again, and it mirrors `c.deleted_at is null`
     -- above exactly: a scene artifact none of whose members is deleted still holds these bytes,
     -- and one with a deleted member does not, because it is itself doomed.
     --
     -- ASKED OF `deleted_at` AND NOT OF `tombstone_blocks_scene`, which is deliberate and is the
     -- same split this function already has with `tombstone_blocks_capture`. This one answers
     -- "may these bytes be destroyed", and 0013's own scope paragraph says the purger does not
     -- act on interval scope, because a redaction removes a moment and not a photograph. The
     -- predicate in section 3 answers "may this be served or written", which is authoritative
     -- from the moment a tombstone commits and does cover interval scope. Two questions, two
     -- reductions, and the enqueue above never fires for an interval tombstone anyway.
     --
     -- `deleted_at` is also the only one of the two this can ask. `tombstone` is not among the
     -- tables the purge role reads across workspaces, so a predicate reading it would see
     -- another tenant's scene as untombstoned, and both tenants' purgers would then refuse the
     -- shared bytes for ever, each blind to the other's deletion.
     and not exists (select 1 from artifact a
                      where a.content_sha256 = p_bytes
                        and a.scene_id is not null
                        and a.purged_at is null
                        and not exists (
                              select 1 from reconstruction_scene_member m
                                join capture c on c.capture_id = m.capture_id
                               where m.workspace_id = a.workspace_id
                                 and m.scene_id = a.scene_id
                                 and c.deleted_at is not null));
end $fn$;

comment on function purge_releases_bytes(bytea) is
  'May these exact bytes be destroyed: no live capture, no unpurged artifact of a live capture, '
  'and no unpurged scene artifact all of whose members are live. Raises on NULL rather than '
  'failing open. Only as truthful as the caller can see; the purge role is granted a '
  'cross-workspace read for exactly this question.';

-- --------------------------------------------------------------------------------------------
-- 6. Row-level security. ENABLE alone is bypassed by the table owner.
-- --------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['reconstruction_scene', 'reconstruction_scene_member'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy ws_isolation on %I using (workspace_id = current_workspace()) '
      'with check (workspace_id = current_workspace())', t);
  end loop;
end $$;

commit;

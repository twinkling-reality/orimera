-- 0002_naming_and_admission.sql
-- Three things migration 0001 left to a comment, the one function the ingest admission check
-- needs, and a one-word correction that restores the deletion guarantee 0001 believed it had.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- The first two are the defects that block identity work, and they are the same shape as the
-- defect 0001 was written to close. 0001 hardened `assertion` so that a model cannot file a
-- name. It did not harden the column the name ends up in, and it did not stop an UPDATE
-- rewriting a model's row into a user's one. Both were confirmed by live probe against the
-- committed schema: an insert and an update setting entity.display_name were ACCEPTED with no
-- assertion in existence, and
--
--   update assertion set kind='user', predicate_id=<name_is>, stated_by_user='<any uuid>'
--
-- on an existing model-produced row was ACCEPTED and still carried produced_by_run.

begin;

-- Serialise against a concurrent applier, exactly as 0001 does and with the same key.
select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. The admission question, which is not the same question the write guards ask.
--
-- tombstone_blocks_span() answers "may this row be written now". An ingest has to answer a
-- different one BEFORE it writes anything: "given that I am about to register a live capture
-- for these bytes, will the span write be refused?" The two differ in exactly one branch. A
-- capture-scope tombstone releases once some live capture claims the bytes again, and at
-- admission time that capture does not exist yet, so tombstone_blocks_span() would say yes to
-- every deliberate re-import.
--
-- It matters that this lives here rather than in the application. The object store is not in
-- the database transaction, so bytes written before a refusal survive the rollback and purged
-- content comes back. The admission check is therefore the only thing standing between a
-- correctly cancelled import and a resurrected file, and a second implementation of the rule
-- in Python is a second thing that can drift from the trigger it is supposed to agree with.
create or replace function tombstone_admits_new_capture(
  p_workspace uuid,
  p_blob      bytea,
  p_track     text,
  p_start_ns  bigint,
  p_end_ns    bigint
) returns boolean
-- VOLATILE for the same reason as tombstone_blocks_span: a stable function reuses the statement
-- snapshot and would not see a tombstone that commits while this runs.
language sql volatile as $fn$
  select not exists (
    select 1
      from tombstone t
      left join capture c on c.capture_id = t.capture_id
     where t.workspace_id = p_workspace
       -- clock_timestamp(), not now(), for the reason section 1b sets out.
       and t.effective_at <= clock_timestamp()
       and (
             t.scope = 'workspace'
          -- An explicit "never let this content back in" is not released by re-importing it.
          -- That is the whole difference between blocklist_hash and an ordinary deletion.
          or (t.blocklist_hash and c.blob_sha256 = p_blob)
          -- The capture branch of tombstone_blocks_span is deliberately absent: this caller is
          -- about to create the live capture whose absence is the only reason it would fire.
          or (t.scope = 'interval'
              and c.blob_sha256 = p_blob
              and t.track_key   = p_track
              and t.interval_ns && int8multirange(int8range(p_start_ns, p_end_ns, '[)')))
       )
  );
$fn$;

-- --------------------------------------------------------------------------------------------
-- 1b. now() is the transaction timestamp, and it silently reopened the window the tombstone
--     guards were made VOLATILE to close.
--
-- 0001 says of tombstone_blocks_span: "VOLATILE, not STABLE, and deliberately so. Under READ
-- COMMITTED a stable function reuses the statement snapshot, so a tombstone that commits while
-- this INSERT is running would not be seen. A volatile function takes a fresh snapshot per call,
-- which narrows the time-of-check-to-time-of-use window to the smallest the isolation level
-- allows."
--
-- The volatility works. The predicate does not. `now()` is transaction_timestamp(), pinned when
-- the WRITING transaction began, and a tombstone committed after that point carries an
-- effective_at later than it. Measured, with a tombstone committed 50 ms into an open writing
-- transaction: the row is visible to the guard (a fresh snapshot, as designed), `count(*) from
-- tombstone` is 1, `where effective_at <= now()` is 0, `where effective_at <= clock_timestamp()`
-- is 1, and tombstone_blocks_span returns FALSE. The window was not narrowed to the smallest the
-- isolation level allows; it was the entire duration of the writing transaction.
--
-- clock_timestamp() is the wall clock at the moment of the call, which is what "is this
-- tombstone in effect yet" actually means. A tombstone deliberately scheduled for the future is
-- still correctly excluded until its time arrives; that behaviour is unchanged.
create or replace function tombstone_blocks_span(
  p_workspace uuid,
  p_blob      bytea,
  p_track     text,
  p_start_ns  bigint,
  p_end_ns    bigint
) returns boolean
language sql volatile as $fn$
  select exists (
    select 1
      from tombstone t
      left join capture c on c.capture_id = t.capture_id
     where t.workspace_id = p_workspace
       and t.effective_at <= clock_timestamp()
       and (
             t.scope = 'workspace'
          or (t.blocklist_hash and c.blob_sha256 = p_blob)
          or (t.scope = 'capture'
              and c.blob_sha256 = p_blob
              and not exists (
                    select 1 from capture live
                     where live.workspace_id = p_workspace
                       and live.blob_sha256  = p_blob
                       and live.deleted_at is null))
          or (t.scope = 'interval'
              and c.blob_sha256 = p_blob
              and t.track_key   = p_track
              and t.interval_ns && int8multirange(int8range(p_start_ns, p_end_ns, '[)')))
       )
  );
$fn$;

create or replace function tombstone_blocks_capture(p_workspace uuid, p_capture uuid)
returns boolean
language sql volatile as $fn$
  select exists (
    select 1 from tombstone t
     where t.workspace_id = p_workspace
       and t.effective_at <= clock_timestamp()
       and (t.scope = 'workspace' or (t.scope in ('capture','interval')
                                      and t.capture_id = p_capture))
  );
$fn$;

create or replace function tombstone_blocks_entity(p_workspace uuid, p_entity uuid)
returns boolean
language sql volatile as $fn$
  select exists (
    select 1 from tombstone t
     where t.workspace_id = p_workspace
       and t.effective_at <= clock_timestamp()
       and (t.scope = 'workspace' or (t.scope = 'entity' and t.entity_id = p_entity))
  );
$fn$;

-- --------------------------------------------------------------------------------------------
-- 2. R2. One UPDATE laundered a model row into a user-stated name.
--
-- `user_names_its_author` only required stated_by_user to be non-null, and any UUID satisfies
-- it. The laundered row kept produced_by_run pointing at the pipeline run that produced it,
-- which is what makes this checkable: a claim the user made was not produced by a run.
alter table assertion
  add constraint a_user_statement_has_no_producing_run
    check (kind <> 'user' or produced_by_run is null);

-- The other half of R2. `update assertion set object_value = ...` rewrote a name in place with
-- no supersedes and no retraction, bypassing the bitemporal machinery built for exactly that.
--
-- The mutable surface of an assertion is its epistemic status and its calibration, and nothing
-- else. What it claims, who claims it, and what evidence it stands on are the row's identity;
-- changing any of them makes every citation already issued against it point at a different
-- claim than the one that was cited. History is corrected by writing a new row that supersedes
-- this one, or by a retraction, both of which leave the original readable.
--
-- Named to sort AFTER tg_assertion_kind_is_allowed. Triggers of the same timing fire in
-- alphabetical order, and an update that moves `kind` or `predicate_id` should still be
-- refused by the guard that can name the predicate and explain the rule.
create or replace function tg_assertion_no_in_place_rewrite() returns trigger
language plpgsql as $fn$
declare
  v_changed text;
begin
  v_changed := case
    when new.kind             is distinct from old.kind             then 'kind'
    when new.predicate_id     is distinct from old.predicate_id     then 'predicate_id'
    when new.subject_ref      is distinct from old.subject_ref      then 'subject_ref'
    when new.object_ref       is distinct from old.object_ref       then 'object_ref'
    when new.object_value     is distinct from old.object_value     then 'object_value'
    when new.valid_time       is distinct from old.valid_time       then 'valid_time'
    when new.support_span_ids is distinct from old.support_span_ids then 'support_span_ids'
    when new.produced_by_run  is distinct from old.produced_by_run  then 'produced_by_run'
    when new.stated_by_user   is distinct from old.stated_by_user   then 'stated_by_user'
    when new.external_source  is distinct from old.external_source  then 'external_source'
    when new.raw_score        is distinct from old.raw_score        then 'raw_score'
    when new.asserted_at      is distinct from old.asserted_at      then 'asserted_at'
    when new.emit_key         is distinct from old.emit_key         then 'emit_key'
    when new.supersedes       is distinct from old.supersedes       then 'supersedes'
    when new.assertion_id     is distinct from old.assertion_id     then 'assertion_id'
    when new.workspace_id     is distinct from old.workspace_id     then 'workspace_id'
    else null
  end;
  if v_changed is not null then
    raise exception
      'assertion % is not editable: % may not be rewritten in place', old.assertion_id, v_changed
      using errcode = 'integrity_constraint_violation',
            hint = 'Write a new assertion with supersedes set, or record a retraction. '
                   'Only status, calibration_id and calibrated_p are mutable.';
  end if;
  return new;
end $fn$;

create trigger tg_assertion_no_in_place_rewrite
  before update on assertion
  for each row execute function tg_assertion_no_in_place_rewrite();

-- --------------------------------------------------------------------------------------------
-- 3. R1. entity.display_name was enforced by a comment.
--
-- 0001 says `display_name text, -- written ONLY via a 'user' assertion` and there is no
-- trigger, no constraint and no check. This is the single most important column in canonical
-- state: it is the one place a person's name lives, and invariant 4 is the promise that a
-- model never writes one.
--
-- The rule enforced here is that the column is a CACHE of a naming assertion. A non-null
-- display_name requires an active assertion of kind 'user', under a predicate that declares
-- itself a naming predicate, whose subject is this entity and whose object is this exact name.
-- The predicate is matched by writes_a_name rather than by the key 'name_is', for the same
-- reason 0001 gives: a later 'nickname_is' must not escape the rule by being spelled
-- differently.
--
-- Two orderings both satisfy this, and both are intended. Create the entity unnamed, write the
-- naming assertion, then set the name; or choose the entity id up front, write the assertion
-- against it, then insert the entity already named.
create or replace function tg_entity_name_is_user_stated() returns trigger
language plpgsql as $fn$
begin
  if new.display_name is null then
    return new;
  end if;
  -- Same reason as every other guard: this reads `assertion`, which is under FORCE row-level
  -- security, so a session that never declared a workspace would see no naming assertion and
  -- this would fail OPEN in the one place where failing open is worst.
  perform assert_workspace_context(new.workspace_id);
  if not exists (
    select 1
      from assertion a
      join predicate p on p.predicate_id = a.predicate_id
     where a.workspace_id = new.workspace_id
       and a.kind         = 'user'
       and a.status       = 'active'
       and p.writes_a_name
       and a.subject_ref  = jsonb_build_object('type', 'entity', 'id', new.entity_id::text)
       and a.object_value = to_jsonb(new.display_name)
  ) then
    raise exception
      'entity % may not be named %: no active user assertion says so',
      new.entity_id, new.display_name
      using errcode = 'integrity_constraint_violation',
            hint = 'A name enters canonical state only as the object of an active '
                   'kind=user assertion under a writes_a_name predicate.';
  end if;
  return new;
end $fn$;

create trigger tg_entity_name_is_user_stated
  before insert or update of display_name on entity
  for each row execute function tg_entity_name_is_user_stated();

-- The other direction, without which the guarantee holds only at the instant of writing. A
-- name that outlives the statement supporting it is exactly the failure the deletion design
-- exists to prevent: the user retracts "this is Marjorie" and the label stays on the screen.
--
-- Nulling the cache rather than refusing the retraction is the right way round. A retraction
-- is the user changing their mind, and the system does not get to refuse that; what it has to
-- do is stop repeating the old claim.
create or replace function tg_entity_name_follows_its_assertion() returns trigger
language plpgsql as $fn$
declare
  v_writes_a_name boolean;
begin
  -- Consistent with every other guard, and not merely defensive. This reads and writes
  -- `entity`, which is under FORCE row-level security: a session with no workspace declared
  -- would find no entity to clear and would leave the retracted name on the screen, which is
  -- the failure this trigger exists to prevent.
  perform assert_workspace_context(new.workspace_id);
  select p.writes_a_name into v_writes_a_name
    from predicate p where p.predicate_id = new.predicate_id;
  if not coalesce(v_writes_a_name, false) or new.status = 'active' then
    return new;
  end if;
  update entity e
     set display_name = null
   where e.workspace_id = new.workspace_id
     and e.display_name = (new.object_value #>> '{}')
     and e.entity_id::text = (new.subject_ref ->> 'id')
     and not exists (
       select 1
         from assertion a
         join predicate p on p.predicate_id = a.predicate_id
        where a.workspace_id  = new.workspace_id
          and a.assertion_id <> new.assertion_id
          and a.kind          = 'user'
          and a.status        = 'active'
          and p.writes_a_name
          and a.subject_ref   = jsonb_build_object('type', 'entity', 'id', e.entity_id::text)
          and a.object_value  = to_jsonb(e.display_name)
     );
  return new;
end $fn$;

-- AFTER, not BEFORE: the query above has to see the new status to decide whether any OTHER
-- active naming assertion still supports the name.
create trigger tg_entity_name_follows_its_assertion
  after update of status on assertion
  for each row execute function tg_entity_name_follows_its_assertion();

commit;

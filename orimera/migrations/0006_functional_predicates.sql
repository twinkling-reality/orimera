-- 0006_functional_predicates.sql
-- `predicate.functional` becomes a rule instead of a comment.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- 0001 line 351 reads `functional boolean not null default false, -- at most one active object
-- per subject`. No constraint, no index and no trigger read the column. Confirmed by writing a
-- second `reconstruction_rung_is` for one capture and watching both rows come back `active`.
-- That is defect R16, and it is the same shape as R1 (`entity.display_name` "written ONLY via a
-- 'user' assertion", with nothing enforcing it) and R4 (`writes_a_name`, self declared): a
-- property stated in the schema where enforcement would go, relied on in prose, held up by
-- nobody.
--
-- It affects `name_is`, `place_is`, `captured_at`, `device_model_is`, `gps_position_is`,
-- `pixel_size_is` and `reconstruction_rung_is`.
--
-- SUPERSEDE, NOT REFUSE, and the schema had already decided this. 0002's
-- tg_assertion_no_in_place_rewrite says "History is corrected by writing a new row that
-- supersedes this one, or by a retraction, both of which leave the original readable." A
-- functional predicate accepting a new active claim and retiring the previous one IS that rule.
-- Refusing would force every caller into retract-then-write, which is two round trips and a
-- window in which the subject has no current claim at all.
--
-- ---------------------------------------------------------------------------------------------
-- THE THING THAT ALMOST WENT WRONG, recorded because the naive version is the obvious one.
--
-- A BEFORE INSERT trigger that retires the previous active row DESTROYS canonical state on every
-- idempotent re-run. `AssertionWriter.insert` writes
-- `on conflict (workspace_id, emit_key) do nothing`, and a BEFORE INSERT row trigger fires
-- BEFORE the uniqueness check that skips the row. So the trigger retired the previous claim and
-- then the replacement was never inserted.
--
-- Measured, on a scratch database, with place_is:
--
--     after first insert   [('the courtyard', 'active')]
--     after a newer claim  [('the courtyard', 'superseded'), ('the terrace', 'active')]
--     after a RE-RUN       [('the courtyard', 'superseded'), ('the terrace', 'superseded')]
--     ACTIVE ROWS: 0
--
-- Re-running an ingest is meant to be free and is the normal thing to do. The naive version
-- would have silently blanked `captured_at`, `gps_position_is`, `place_is` and every name in the
-- library on the second pass. The emit_key guard below is the whole fix, and
-- `test_a_re_run_of_an_identical_claim_does_not_retire_the_one_it_would_replace` fails without
-- it.
-- ---------------------------------------------------------------------------------------------

begin;

-- Serialise against a concurrent applier, with the same key every migration uses.
select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. The flag, mirrored onto the row, because a partial index cannot see another table.
--
-- The guarantee wanted is a unique index over (workspace_id, predicate_id, subject) where the
-- predicate is functional and the status is active. A partial index predicate may only reference
-- columns of the table being indexed, and `functional` lives on `predicate`. The alternatives
-- were both worse: enumerating the functional predicate_ids as literals in the index predicate
-- silently stops covering the next one somebody seeds, and an IMMUTABLE function that reads
-- `predicate` would be a lie about immutability that can corrupt an index.
--
-- So the flag is copied onto the assertion row at insert time by the trigger below, and the
-- index reads the copy. Drift is the obvious objection and it is answered by privilege: 0003's
-- fix for R3 grants the runtime role SELECT on `predicate` and revokes INSERT and UPDATE, so
-- only a migration can change `functional`, and a migration that changes it must backfill this
-- column in the same transaction.
alter table assertion
  add column predicate_is_functional boolean not null default false;

comment on column assertion.predicate_is_functional is
  'Copy of predicate.functional at insert time, maintained by trigger and never by a caller. '
  'It exists so the partial unique index below can see it: an index predicate cannot reference '
  'another table. A migration that changes predicate.functional must backfill this column.';

update assertion a
   set predicate_is_functional = true
  from predicate p
 where p.predicate_id = a.predicate_id
   and p.functional;

-- --------------------------------------------------------------------------------------------
-- 2. Resolve whatever the unenforced years left behind, before the index refuses to build.
--
-- Newest active wins and the rest become superseded. This is not a new policy: it is exactly
-- what `orimera/api/routes/graph.py::_rung_by_capture` already does, ordering by
-- `asserted_at desc, assertion_id desc` because the flag could not be relied on. So this makes
-- the stored state agree with what was already on screen, and nobody can observe a change.
--
-- `supersedes` is deliberately NOT reconstructed for these rows. There is no evidence of which
-- claim retired which; inventing a chain would be inventing provenance, which is the one thing
-- this schema exists to refuse.
with ranked as (
  select a.assertion_id,
         row_number() over (
           partition by a.workspace_id, a.predicate_id,
                        a.subject_ref ->> 'type', a.subject_ref ->> 'id'
           order by a.asserted_at desc, a.assertion_id desc) as rn
    from assertion a
    join predicate p on p.predicate_id = a.predicate_id
   where p.functional
     and a.status = 'active')
update assertion a
   set status = 'superseded'
  from ranked r
 where r.assertion_id = a.assertion_id
   and r.rn > 1;

-- --------------------------------------------------------------------------------------------
-- 3. The trigger. It supersedes, and it knows when not to.
create or replace function tg_assertion_supersedes_the_previous_functional_claim()
returns trigger
language plpgsql as $fn$
declare
  v_functional boolean;
  v_previous   uuid;
begin
  select p.functional into v_functional
    from predicate p where p.predicate_id = new.predicate_id;
  new.predicate_is_functional := coalesce(v_functional, false);

  -- A claim filed as anything other than active is not the current one and retires nothing.
  if not new.predicate_is_functional or new.status <> 'active' then
    return new;
  end if;

  -- THE EMIT KEY GUARD. See the block comment at the top of this file. `AssertionWriter.insert`
  -- uses ON CONFLICT DO NOTHING on (workspace_id, emit_key), and this trigger runs BEFORE that
  -- conflict is detected. Retiring the previous row here, for an insert that is about to be
  -- skipped, leaves the subject with no current claim. Re-running an ingest is free and normal,
  -- so this is the difference between an idempotent pipeline and one that blanks the library on
  -- its second pass.
  if exists (select 1 from assertion a
              where a.workspace_id = new.workspace_id
                and a.emit_key = new.emit_key) then
    return new;
  end if;

  -- Scoped by workspace_id explicitly rather than left to row-level security. If a session with
  -- no workspace context reached here the UPDATE would match nothing, no row would be retired,
  -- and the unique index below would then refuse the insert. That failure is loud, which is why
  -- this function does not call assert_workspace_context the way the naming triggers do: they
  -- would fail OPEN without it and this fails CLOSED.
  update assertion a
     set status = 'superseded'
   where a.workspace_id = new.workspace_id
     and a.predicate_id = new.predicate_id
     and a.subject_ref  = new.subject_ref
     and a.status       = 'active'
  returning a.assertion_id into v_previous;

  if v_previous is not null and new.supersedes is null then
    new.supersedes := v_previous;
  end if;
  return new;
end $fn$;

-- Named to sort after tg_assertion_kind_is_allowed, so a claim filed under a kind the predicate
-- forbids is refused by the guard that can explain it before anything is retired. Every other
-- guard on this table raises rather than skipping, and a raise rolls this UPDATE back with the
-- statement, so ordering is a courtesy to the error message rather than a correctness rule. The
-- one path that does NOT raise is ON CONFLICT DO NOTHING, and that is what the emit_key guard
-- above is for.
create trigger tg_assertion_supersedes_the_previous_functional_claim
  before insert on assertion
  for each row execute function tg_assertion_supersedes_the_previous_functional_claim();

-- --------------------------------------------------------------------------------------------
-- 4. The index, which is what makes it a guarantee rather than a habit.
--
-- The trigger is the mechanism and this is the proof. Two concurrent inserts for one subject
-- each see no previous active row to retire, because neither transaction's UPDATE is visible to
-- the other under READ COMMITTED, and both insert. The index blocks the second until the first
-- commits and then refuses it, so a race becomes a serialisation failure the caller can retry
-- rather than a second current name nobody notices.
--
-- It also covers the routes the trigger cannot see: an UPDATE that sets a superseded row back to
-- active while another is current is refused here.
create unique index assertion_one_active_claim_per_functional_subject
  on assertion (workspace_id, predicate_id, (subject_ref ->> 'type'), (subject_ref ->> 'id'))
  where status = 'active' and predicate_is_functional;

-- --------------------------------------------------------------------------------------------
-- 5. The mirror is not a caller's to edit.
--
-- 0002's tg_assertion_no_in_place_rewrite lists every column that may not be rewritten in place.
-- `predicate_is_functional` is new and would not be on that list, and flipping it to false would
-- lift a row out of the index and allow a second current claim beside it. Redefined here with
-- the column added rather than a second trigger, because two triggers answering "may this
-- UPDATE proceed" is two places for the answer to drift.
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
    when new.predicate_is_functional is distinct from old.predicate_is_functional
      then 'predicate_is_functional'
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

commit;

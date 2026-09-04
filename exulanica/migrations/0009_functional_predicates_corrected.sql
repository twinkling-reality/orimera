-- 0009_functional_predicates_corrected.sql
-- Four defects in 0006, each found by measurement and each fixed here.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- 0006 made `predicate.functional` real and its central decision was right: supersede rather than
-- refuse, in a BEFORE INSERT trigger, guarded against `ON CONFLICT DO NOTHING`. Its emit_key
-- guard is load bearing and is kept unchanged. What follows are the four things it got wrong.
-- They are corrected forward rather than by editing 0006, because an applied migration's
-- checksum is what stops two deployments claiming one version with different tables.
--
-- ONE THING TO CORRECT IN THE RECORD FIRST. 0006's comment at "Drift is the obvious objection"
-- says "0003's fix for R3 grants the runtime role SELECT on `predicate` and revokes INSERT and
-- UPDATE". That citation is wrong. R3 was closed in `orimera/db/roles.py`, which grants and
-- revokes at runtime; migration 0003 is `0003_intake_batch.sql` and has nothing to do with it.
-- The claim it supports is still true, and it is now supported by the right thing.
--
-- ---------------------------------------------------------------------------------------------
-- DEFECT 1. The trigger and the index disagreed about what a subject is.
--
-- The trigger matched `a.subject_ref = new.subject_ref`, whole-document jsonb equality. The index
-- keys on `(subject_ref ->> 'type', subject_ref ->> 'id')`. Measured: inserting
-- `{"type":"capture","id":"X"}` and then `{"type":"capture","id":"X","note":"n"}` retires nothing
-- (the trigger sees two subjects) and is then refused by the index (which sees one). A write that
-- should have superseded fails with a constraint name instead.
--
-- DEFECT 2. A claim about the past retired the claim about the present.
--
-- Measured, both under `place_is` on one capture:
--
--     "the terrace now"        valid_time NULL                      -> superseded
--     "the courtyard in 2019"  valid_time [2019-04-01,2019-04-08)   -> active
--
-- 0001 calls `valid_time` and `asserted_at` "Bitemporal: when the claim is ABOUT, versus when it
-- was RECORDED", and `AssertionWriter.insert` takes `valid_time` as a parameter. As 0006 landed,
-- a functional predicate had no bitemporal history at all: recording what a place used to be
-- deleted what it is. That was decided by an index that does not mention `valid_time` rather than
-- by anybody. "At most one active object per subject" becomes "per subject, per validity
-- interval", which is what the domain model means and what stops the data loss.
--
-- RESIDUAL, stated rather than quietly left: two OVERLAPPING but unequal intervals are both
-- permitted. Closing that needs an exclusion constraint over a range, which is a larger change
-- with its own blast radius, and nothing writes `valid_time` today. It is a real gap and it is
-- narrower than the one it replaces.
--
-- DEFECT 3. The index destroyed claims under concurrency.
--
-- Six concurrent transactions, six different claims about one subject, measured:
--
--     0006 as landed:  1 of 6 committed, 5 UniqueViolation,   1 active,  0 history
--     with this fix:   6 of 6 committed, 0 errors,            1 active,  5 superseded
--
-- 0006 claimed the race "becomes a serialisation failure the caller can retry". Nothing retries,
-- and a retry of the same emit_key would be deduplicated anyway, so five claims were lost rather
-- than retried. The lock makes the writers queue and each one supersede the last, which is
-- exactly what 0002 says the schema wants: history is corrected by a new row that supersedes,
-- "both of which leave the original readable".
--
-- THE LOCK GOES FIRST, BEFORE THE EMIT KEY GUARD, and the order is the whole of it. Placed after
-- the guard it is worse than absent: two transactions with the same emit_key both pass the guard
-- on their own snapshot, then serialise, and the loser retires the winner's row for an insert
-- that `ON CONFLICT` then skips. Measured that way it leaves ZERO active rows, which is the
-- original catastrophe wearing a lock. Placed first, the loser takes the lock only after the
-- winner commits, sees the emit_key, and does nothing at all.
--
-- The index is kept. It is the backstop for the routes a BEFORE INSERT trigger cannot see, such
-- as an UPDATE reactivating a superseded row, and with the lock in place it no longer fires in
-- the ordinary race.
--
-- DEFECT 4. The mirror column could never be backfilled.
--
-- 0006 justified copying `predicate.functional` onto the assertion row by arguing that only a
-- migration can change the flag and "a migration that changes it must backfill this column in
-- the same transaction". Measured: it cannot. 0006 added `predicate_is_functional` to
-- `tg_assertion_no_in_place_rewrite`'s forbidden list, so the backfill is refused by the guard
-- that 0006 itself extended. The column was write-once and the drift would have been permanent.
--
-- Fixed by permitting exactly one change and no other: setting the mirror to what the vocabulary
-- now says. That is a backfill and it is nothing else. Any other value is still refused.
-- ---------------------------------------------------------------------------------------------

begin;

select pg_advisory_xact_lock(119622309);

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

  if not new.predicate_is_functional or new.status <> 'active' then
    return new;
  end if;

  -- FIRST. See DEFECT 3 above: after the emit_key guard this lock makes things worse rather
  -- than better. The key is the same tuple the index is built on, so two writers about one
  -- subject in one validity interval queue and two writers about different subjects do not.
  perform pg_advisory_xact_lock(hashtextextended(
    new.workspace_id::text || ':' || new.predicate_id::text || ':' ||
    coalesce(new.subject_ref ->> 'type', '') || ':' ||
    coalesce(new.subject_ref ->> 'id', '') || ':' ||
    coalesce(new.valid_time::text, ''), 0));

  -- The emit_key guard, unchanged from 0006, which is the thing that stops an idempotent re-run
  -- retiring a claim whose replacement ON CONFLICT is about to skip.
  if exists (select 1 from assertion a
              where a.workspace_id = new.workspace_id
                and a.emit_key = new.emit_key) then
    return new;
  end if;

  -- Matched exactly as the index keys, so the two can never disagree about what a subject is.
  -- `is not distinct from` rather than `=` throughout: a subject_ref with no 'id', or a NULL
  -- valid_time, must compare equal to another of the same shape, and `=` yields NULL for those.
  update assertion a
     set status = 'superseded'
   where a.workspace_id = new.workspace_id
     and a.predicate_id = new.predicate_id
     and a.subject_ref ->> 'type' is not distinct from new.subject_ref ->> 'type'
     and a.subject_ref ->> 'id'   is not distinct from new.subject_ref ->> 'id'
     and a.valid_time             is not distinct from new.valid_time
     and a.status = 'active'
  returning a.assertion_id into v_previous;

  if v_previous is not null and new.supersedes is null then
    new.supersedes := v_previous;
  end if;
  return new;
end $fn$;

-- The index gains `valid_time`, and NULLS NOT DISTINCT is what makes that safe. By default a
-- unique index treats every NULL as distinct, so two claims about the present would both be
-- permitted and the guarantee would evaporate for the ordinary case while appearing to hold.
drop index if exists assertion_one_active_claim_per_functional_subject;

create unique index assertion_one_active_claim_per_functional_subject
  on assertion (
    workspace_id, predicate_id, (subject_ref ->> 'type'), (subject_ref ->> 'id'), valid_time)
  nulls not distinct
  where status = 'active' and predicate_is_functional;

-- The mirror becomes maintainable, and only in the one direction that is a backfill. A change
-- that sets it to anything other than what the vocabulary currently says is still refused, so
-- the column cannot be edited to lift a row out of the index.
create or replace function tg_assertion_no_in_place_rewrite() returns trigger
language plpgsql as $fn$
declare
  v_changed    text;
  v_functional boolean;
begin
  if new.predicate_is_functional is distinct from old.predicate_is_functional then
    select p.functional into v_functional
      from predicate p where p.predicate_id = new.predicate_id;
    if new.predicate_is_functional is distinct from coalesce(v_functional, false) then
      raise exception
        'assertion %: predicate_is_functional may only be set to what the vocabulary says (%)',
        old.assertion_id, coalesce(v_functional, false)
        using errcode = 'integrity_constraint_violation',
              hint = 'This column is a copy of predicate.functional maintained by trigger. The '
                     'only legal write is a migration bringing it back into agreement after the '
                     'vocabulary changed.';
    end if;
  end if;

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

commit;

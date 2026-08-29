-- 0007_a_vocabulary_row_states_whether_it_names.sql
-- R4. Silence stops being an answer to "does this predicate write a name".
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- R4 as recorded: "Seeding `alias_is` with `writes_a_name=false, allows_kind={inference}` is
-- accepted, and a model may then write 'Aunt Marjorie' into it. The migration comment
-- anticipates this, so it is a documented dependency rather than a surprise, but the guarantee
-- rests on whoever adds a vocabulary row rather than on the schema."
--
-- WHAT THIS DOES NOT DO, said first so the rest is not read as more than it is. Whether a
-- predicate's object IS a name is a semantic property, and no database decides one. A regex over
-- keys was rejected in 0001 for a reason that still holds: "the vocabulary churns weekly and a
-- rule spelled as a string comparison is a rule the next key silently escapes." A classifier
-- would be a model deciding what models may write. So R4 is NOT closed as a database rule and is
-- not claimed to be.
--
-- WHAT IT DOES. Today the column defaults to false, which is both the common case and the unsafe
-- one, so a vocabulary row whose author never thought about naming is silently declared not to
-- name anyone. Measured against 0001 through 0006: an insert naming only
-- (key, value_schema, allows_kind) is ACCEPTED and reads back writes_a_name = false. After this
-- it raises not_null_violation naming the column, which converts "forgot" into "decided".
--
-- It does not convert "decided wrong" into anything. That is what
-- `orimera/epistemics/vocabulary.py` is for: the answer becomes a written sentence in a reviewed
-- diff, beside the boolean it justifies, rather than a `false` in the fourth column of a values
-- tuple nobody reads twice.
--
-- WHY NOT `default true`, which would fail closed. Because it silently RECLASSIFIES any
-- user-only predicate as a naming predicate, and `tg_entity_name_is_user_stated` accepts a
-- `display_name` supported by ANY `writes_a_name` predicate, so an accidental reclassification
-- widens what may set a person's name. It would also refuse an author who never mentioned naming
-- with a message about `a_name_comes_only_from_the_user`, which points at the wrong thing.
-- Dropping the default is louder and reclassifies nothing.
--
-- `functional` had the same shape and is deliberately not touched here. It is R16's, closed in
-- 0006, and two decisions in one migration is how the second one stops being reviewed.

begin;

-- Serialise against a concurrent applier, with the same key every migration uses.
select pg_advisory_xact_lock(119622309);

alter table predicate alter column writes_a_name drop default;

comment on column predicate.writes_a_name is
  'Whether this predicate''s object is the name a PERSON is called by. It has no default: '
  'omitting it raises, because the fail-open value was the one an author got by saying nothing. '
  'The answer itself is recorded in orimera/epistemics/vocabulary.py, which the test suite '
  'checks against this table row for row. Enforcement of the answer is not possible here and is '
  'not claimed: what is enforced is that somebody answered.';

commit;

-- 0005_reconstruction_rung.sql
-- The rung a region earned, as a claim with a provenance class rather than a column.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- ``product-specification.md`` 5.1: "Each region displays the rung it earned, in the interface, as
-- a normal part of the region's identity. It is not hidden, not smoothed over, and not described
-- in language that implies a higher rung than was achieved."
--
-- WHY A PREDICATE AND NOT A COLUMN ON ``capture``. Because the rung is not a property of the
-- photograph. It is what a particular model, at a particular version, managed to place from that
-- photograph, and a different checkpoint gives a different answer over the same bytes. A column
-- would make it look like a fact the file carries, which is exactly the flattening invariant 4
-- forbids: capture-supported observation and model inference are two different things and are
-- never merged.
--
-- ``allows_kind`` is ``{inference}`` alone, and that is the enforcement rather than a convention.
-- ``tg_assertion_kind_is_allowed`` refuses, inside the writing transaction, any assertion whose
-- kind is absent from its predicate's ``allows_kind``. So this row is what makes it impossible to
-- file a rung as a capture-supported fact, however the pipeline is later rewritten.
--
-- ``functional`` is true: a capture has one current rung. Re-running reconstruction at a new stage
-- version supersedes the previous claim rather than accumulating a second one, and the history is
-- readable because nothing is ever silently rewritten.
--
-- ``writes_a_name`` is false, and it matters that it is stated. Defect R4 records that the flag is
-- self-declared and that vocabulary discipline carries the guarantee; a rung is a number and a
-- reason and could never be a name, so the honest value is the one that lets the name guard keep
-- meaning what it means.

begin;

-- Serialise against a concurrent applier, with the same key every migration uses.
select pg_advisory_xact_lock(119622309);

insert into predicate (key, value_schema, functional, allows_kind, writes_a_name) values
  ('reconstruction_rung_is',
   '{"type":"object","required":["rung","valid_fraction","reason"],
     "properties":{
       "rung":{"type":"integer","minimum":1,"maximum":4},
       "valid_fraction":{"type":"number","minimum":0,"maximum":1},
       "reason":{"type":"string"},
       "model_id":{"type":"string"},
       "metric":{"type":"boolean"},
       "point_map_artifact":{"type":"string"}}}',
   true,
   '{inference}',
   false)
on conflict (key) do nothing;

commit;

-- 0004_stage_reused.sql
-- A stage resolved from an existing artifact is a thing that happened, and the ledger did not
-- record it.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- ``orimera/ingest/ledger.py`` opens with the rule this migration exists to restore: "anything
-- not recorded in the ledger can never be shown to a user", and "the Assembly Replay must rebuild
-- the DAG from the ledger alone: a DAG that is only implicit in the source lies as soon as the
-- source changes, and it lies most convincingly about old runs."
--
-- Reuse was implicit in the source. When ``rendition`` resolves from an existing artifact the
-- pipeline returns before it opens a ledger stage, so the run writes no event for that stage at
-- all. The consequence is exactly the one the docstring predicts: replay a re-ingested photograph
-- and the DAG has no rendition step in it. It did have one; it was satisfied by an artifact that
-- already existed, which is a different thing from not having happened.
--
-- WHY NOT ``stage_succeeded``. Because the stage did not run, and the second rule in that file is
-- "do not record anything you cannot measure". A succeeded event carries a duration and a cost
-- for work that was performed, and writing one with zeroes would be recording a measurement of
-- something that did not occur. A distinct type says what is true: this stage was satisfied, from
-- this artifact, without running.
--
-- This also makes the formation stream tell the truth about a second ingest. A photograph whose
-- rendition already existed IS extracted, and a progress count that skipped it would show "3 of
-- 6" over a corpus that is entirely ready. The counter answers "how many photographs have
-- finished this stage", which is the question a person watching is asking, and not "how much work
-- did the machine do".

begin;

-- Serialise against a concurrent applier, with the same key 0001, 0002 and 0003 use.
select pg_advisory_xact_lock(119622309);

-- Safe inside a transaction on PostgreSQL 12 and later provided the new label is not USED in the
-- same transaction, which it is not: nothing below writes an event.
alter type pipeline_event_type add value if not exists 'stage_reused';

commit;

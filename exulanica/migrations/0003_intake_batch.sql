-- 0003_intake_batch.sql
-- The unit the interface calls a capture, which is not the unit this schema calls a capture.
--
-- Target: PostgreSQL 18, same as 0001 and 0002. Forward-only, same as both.
--
-- ``interaction-model.md`` 8.4 specifies formation progress as "server-sent events PER CAPTURE",
-- and section 8 describes a user watching 148 photographs form into one region. This schema's
-- ``capture`` is ONE photograph, and ``pipeline_run`` is one run over one photograph. So the
-- thing section 8 calls a capture has had no row anywhere: a person drops a folder in, and the
-- only record that those photographs arrived together is that their runs happen to be adjacent
-- in time.
--
-- Adjacency in time is not a record. Two ingests started a minute apart, or one ingest and a
-- reprocess, are indistinguishable from it, and a stream built on it would show a visitor other
-- people's photographs forming. So the batch is a row, with an id the stream is addressed by.
--
-- WHAT THIS IS NOT. It is not a capture, and it deliberately does not gain any of a capture's
-- properties: no blob, no clock anchor, no evidence address, nothing that could be cited. An
-- evidence address is (content hash, track key, time interval) and nothing else, and a batch id
-- is none of those. It is a handle for watching work happen, and it is expected to be useless
-- once the work has happened.

begin;

-- Serialise against a concurrent applier, with the same key 0001 and 0002 use.
select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. The batch.
--
-- ``declared_size`` is NULL until the source has been enumerated, and that is the load-bearing
-- part rather than a convenience. Walking a directory takes time, and a client that was handed a
-- total before one existed would render a fraction of a number nobody had counted.
-- ``product-specification.md`` records ASSUMPTION A-29, that the pipeline can emit real per-stage
-- counters, as unsettled; the front end was built so the unsettled half is representable as
-- ABSENT rather than as a lie, and this column is the server side of that. A default of zero, or
-- of the count so far, would each be a number that reads as complete.
create table intake_batch (
  batch_id      uuid primary key default uuidv7(),
  workspace_id  uuid not null,
  -- What the operator called it. Never shown as a fact about the photographs.
  label         text,
  -- NULL means "not yet counted", which is different from zero. See above.
  declared_size int check (declared_size is null or declared_size >= 0),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  status        text not null default 'running'
                check (status in ('running','succeeded','partial','failed','cancelled'))
);

-- --------------------------------------------------------------------------------------------
-- 2. Which batch a run belongs to.
--
-- Nullable, because a run does not need one: a single-file ingest, a reprocess and a repair are
-- all real runs with no batch, and requiring one would mean inventing a batch of one every time
-- to satisfy a column. A NULL here means "this run was not part of a watched intake", which is a
-- true statement rather than missing data.
alter table pipeline_run add column batch_id uuid references intake_batch(batch_id);

-- The stream reads events for one batch in run-then-sequence order, which is exactly this index
-- followed by the existing pipeline_event (run_id, seq) one.
create index pipeline_run_batch_idx on pipeline_run (batch_id, started_at, run_id);

-- --------------------------------------------------------------------------------------------
-- 3. Row-level security, on the same terms as every other workspace-scoped table.
--
-- ENABLE alone is not enough: a table owner bypasses RLS unless FORCE is also set. 0001 records
-- that at length and the omission would be silent here too, so the same two statements and the
-- same policy name are used rather than a variant.
--
-- ``pipeline_event`` is deliberately NOT given a policy, here or in 0001, because it carries no
-- workspace_id: it is reachable only through ``pipeline_run``, and every query that reads it
-- joins through that table and is filtered by ITS policy. Adding a workspace_id to the event
-- table would be a second place the answer could disagree with the first.
alter table intake_batch enable row level security;
alter table intake_batch force  row level security;
create policy ws_isolation on intake_batch
  using (workspace_id = current_workspace())
  with check (workspace_id = current_workspace());

commit;

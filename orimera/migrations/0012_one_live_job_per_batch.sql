-- 0012_one_live_job_per_batch.sql
-- R19. An upload can be watched, and the queue between the two halves holds no bytes.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- `POST /intake` splits one photograph's ingest across two processes. The request thread runs
-- the intake stage, which is a hash, an EXIF read, an orientation transform and a handful of
-- rows, and it runs it synchronously because the alternative is to put the uploaded bytes
-- somewhere until a worker gets to them. There is nowhere to put them: anything outside the
-- content-addressed store is outside every tombstone guard and outside the purger, and
-- invariant 8 says deletion cascades. So the queue holds a capture id, the bytes are already
-- in the one place a deletion reaches, and the worker reads them back out of it.
--
-- `job` has existed since 0001 with no reader. This adds the one column that queue needs and
-- the one index that keeps it honest.
--
-- WHY THE INDEX IS ON (workspace_id, batch_id) AND NOT ON THE JOB KIND AS WELL. The rule it
-- states is "a batch has at most one piece of outstanding work", which is stronger than "at
-- most one derivative run per batch" and is the rule that is actually true: a batch is one
-- watched intake, its terminal event is what tells a client to stop listening, and two live
-- jobs racing to close it would race to write that event. Scoping the index by `kind` would
-- also mean the string 'intake_derivatives' living in a migration and in Python at once, which
-- is a duplication across a language boundary and would need a pin to be safe. The day a second
-- kind of batch job is wanted, this index refuses it and the migration that adds it decides
-- deliberately, which is the outcome worth having.
--
-- WHAT IS DELIBERATELY NOT HERE: a reclaim of a dead worker's `running` row. The claim query
-- filters `state = 'queued'` and `job_queue_idx` is partial on the same, so nothing can see a
-- row stranded in `running` and a reclaim written against this shape would not work. Half a
-- reclaim is worse than none, because it reads as coverage. The gap is R20 on the defect
-- register with what a real one needs.

begin;

select pg_advisory_xact_lock(119622309);

-- Nullable, and the null means "this job does not belong to a watched intake", which is a true
-- statement rather than missing data. `pipeline_run.batch_id` is nullable for the same reason
-- and 0003 says so in the same words.
alter table job add column batch_id uuid references intake_batch(batch_id);

create unique index job_one_live_job_per_batch
  on job (workspace_id, batch_id)
  where batch_id is not null and state in ('queued', 'running');

comment on column job.batch_id is
  'The watched intake this job finishes, or null when the job belongs to no batch. At most one '
  'live job per batch: see job_one_live_job_per_batch.';

commit;

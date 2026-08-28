-- sqlite_mirror.sql
-- The subset of migration 0001 that the photograph ingest path writes, expressed in portable
-- SQL so the data layer is testable without a PostgreSQL server.
--
-- This is a MIRROR, not a second schema. Three rules keep it from becoming a fork:
--
--   1. Every table and column name here also exists in orimera/migrations/0001_spine.sql, with
--      the same meaning. tests/test_sqlite_mirror.py compares the two files and fails on any
--      column this file invents.
--   2. Nothing is added here that the Postgres schema does not have. Where Postgres has a
--      column this path does not write, it is simply absent, which is why the test checks a
--      subset relation in one direction and NOT NULL coverage in the other.
--   3. Postgres-specific types degrade to their portable representation and nothing else
--      changes: bytea -> BLOB, uuid and timestamptz -> TEXT, jsonb and arrays and
--      int8multirange -> JSON TEXT, boolean -> INTEGER 0/1.
--
-- What is deliberately NOT mirrored: row-level security, the tombstone guard trigger, GiST and
-- GIN indexes, halfvec, and uuidv7(). Those are Postgres features with no portable equivalent,
-- and faking them would produce a data layer that passes tests the real one fails. The
-- tombstone table IS mirrored, because the ingest writer checks it in application code and
-- that check is testable.
--
-- The epistemic guard IS mirrored, as triggers, because it is the one invariant here that a
-- portable database can express exactly: a lookup and a set membership test. It was previously
-- enforced only by IngestRepository, which meant any SQL reaching this file by another route
-- could file a model's guess as a user's statement.

create table if not exists blob (
  blob_sha256   BLOB primary key check (length(blob_sha256) = 32),
  byte_size     INTEGER not null check (byte_size >= 0),
  media_type    TEXT    not null,
  storage_key   TEXT,
  purged_at     TEXT,
  first_seen_at TEXT    not null
);

create table if not exists media_track (
  track_id      TEXT primary key,
  blob_sha256   BLOB not null references blob(blob_sha256),
  track_key     TEXT not null,
  kind          TEXT not null check (kind in ('image','video','audio')),
  time_base_num INTEGER not null check (time_base_num > 0),
  time_base_den INTEGER not null check (time_base_den > 0),
  start_pts     INTEGER not null,
  duration_ns   INTEGER not null check (duration_ns > 0),
  coded_w       INTEGER,
  coded_h       INTEGER,
  disp_w        INTEGER,
  disp_h        INTEGER,
  -- 0/90/180/270 only, exactly as in Postgres. Mirroring is expressed by normalising pixels at
  -- ingest, not by widening this column: see orimera/ingest/exif.py.
  rotation      INTEGER check (rotation in (0,90,180,270)),
  sar_num       INTEGER,
  sar_den       INTEGER,
  codec         TEXT not null,
  probe_json    TEXT not null,
  unique (blob_sha256, track_key)
);

create table if not exists capture (
  capture_id   TEXT primary key,
  workspace_id TEXT not null,
  blob_sha256  BLOB not null references blob(blob_sha256),
  device_id    TEXT,
  started_at   TEXT,
  created_at   TEXT not null,
  deleted_at   TEXT
);
-- Live duplicates collapse to one capture; a deliberate re-import after a deletion gets a
-- fresh capture_id. Same partial index as the Postgres schema, same reason.
create unique index if not exists capture_live_bytes_uniq
  on capture (workspace_id, blob_sha256) where deleted_at is null;

create table if not exists clock_anchor (
  anchor_id      TEXT primary key,
  track_id       TEXT not null references media_track(track_id),
  t_ns           INTEGER not null,
  utc_instant    TEXT not null,
  source         TEXT not null check (source in
                   ('container_creation_time','device_rtc','gps','ntp','user_stated','inferred')),
  uncertainty_ms INTEGER not null check (uncertainty_ms >= 0),
  unique (track_id, t_ns, source)
);

create table if not exists evidence_span (
  span_id             TEXT primary key,
  span_format_version INTEGER not null default 1,
  workspace_id        TEXT not null,
  blob_sha256         BLOB not null references blob(blob_sha256),
  track_key           TEXT not null,
  t_start_ns          INTEGER not null,
  t_end_ns            INTEGER not null,
  modality            TEXT not null check (modality in
                        ('still_image','frame_region','video_time','audio_time',
                         'transcript_text')),
  region              TEXT,
  text_anchor         TEXT,
  hint                TEXT,
  span_digest         BLOB not null check (length(span_digest) = 32),
  created_at          TEXT not null,
  -- Half-open and never empty. [0,0) overlaps nothing, so every interval guard would pass it.
  constraint span_non_empty check (t_end_ns > t_start_ns),
  constraint region_only_on_frame_region check (region is null or modality = 'frame_region'),
  constraint region_span_needs_region check (modality <> 'frame_region' or region is not null),
  constraint still_image_is_img_track check (modality <> 'still_image' or track_key = 'img')
);
create unique index if not exists evidence_span_digest_uniq
  on evidence_span (workspace_id, span_digest);
create index if not exists evidence_span_ws_blob_idx
  on evidence_span (workspace_id, blob_sha256, track_key);

create table if not exists stage_registry (
  stage_key       TEXT primary key,
  current_version INTEGER not null,
  model_ref       TEXT,
  params_schema   TEXT not null,
  deterministic   INTEGER not null default 1,
  output_kind     TEXT not null,
  updated_at      TEXT not null
);

create table if not exists pipeline_run (
  run_id       TEXT primary key,
  workspace_id TEXT not null,
  capture_id   TEXT references capture(capture_id),
  "trigger"    TEXT not null check ("trigger" in ('ingest','reprocess','repair','manual')),
  started_at   TEXT not null,
  ended_at     TEXT,
  status       TEXT not null default 'running'
);

create table if not exists pipeline_event (
  event_id            TEXT primary key,
  run_id              TEXT not null references pipeline_run(run_id),
  seq                 INTEGER not null,
  parent_event_id     TEXT references pipeline_event(event_id),
  type                TEXT not null check (type in
                        ('run_started','stage_started','input_resolved','artifact_written',
                         'stage_succeeded','stage_failed','retry_scheduled',
                         'nondeterminism_detected','assertion_emitted','proposal_emitted',
                         'tombstone_applied','run_succeeded','run_failed','run_cancelled')),
  stage_key           TEXT,
  stage_version       INTEGER,
  model_ref           TEXT,
  params_digest       BLOB,
  input_artifact_ids  TEXT not null default '[]',
  output_artifact_ids TEXT not null default '[]',
  input_blob_sha256   BLOB,
  attempt             INTEGER not null default 1,
  max_attempts        INTEGER,
  error_class         TEXT,
  error_message       TEXT,
  started_at          TEXT,
  ended_at            TEXT,
  duration_ms         INTEGER,
  cost                TEXT,
  host                TEXT,
  occurred_at         TEXT not null,
  unique (run_id, seq)
);
create index if not exists pipeline_event_run_seq_idx on pipeline_event (run_id, seq);

create table if not exists artifact (
  artifact_id        TEXT primary key,
  workspace_id       TEXT not null,
  kind               TEXT not null,
  source_blob_sha256 BLOB not null references blob(blob_sha256),
  stage_key          TEXT not null,
  stage_version      INTEGER not null,
  params_digest      BLOB not null,
  input_digest       BLOB not null,
  idempotency_key    TEXT not null,
  content_sha256     BLOB,
  storage_key        TEXT,
  byte_size          INTEGER,
  produced_by_event  TEXT references pipeline_event(event_id),
  superseded_by      TEXT references artifact(artifact_id),
  purged_at          TEXT,
  needs_repair       INTEGER not null default 0,
  created_at         TEXT not null,
  unique (workspace_id, idempotency_key)
);
create index if not exists artifact_lookup_idx
  on artifact (workspace_id, source_blob_sha256, stage_key, stage_version);

create table if not exists predicate (
  predicate_id  INTEGER primary key,
  key           TEXT not null unique,
  value_schema  TEXT not null,
  functional    INTEGER not null default 0,
  allows_kind   TEXT not null,           -- JSON array, e.g. '["user"]'
  -- A predicate whose object IS a name. Same meaning and same purpose as in Postgres: the rule
  -- is a property of the vocabulary row, not a comparison against the key, so a later
  -- 'nickname_is' cannot escape it by being spelled differently.
  writes_a_name INTEGER not null default 0,
  vocab_version INTEGER not null default 1
);

-- The Postgres constraint a_name_comes_only_from_the_user, as a trigger: SQLite permits no
-- subquery inside a CHECK, and comparing the JSON text to a literal would depend on the
-- writer's element order.
create trigger if not exists predicate_naming_is_user_only_insert
before insert on predicate for each row
when new.writes_a_name <> 0
 and exists (select 1 from json_each(new.allows_kind) where value <> 'user')
begin
  select raise(abort, 'a naming predicate may allow only the user kind');
end;

create trigger if not exists predicate_naming_is_user_only_update
before update on predicate for each row
when new.writes_a_name <> 0
 and exists (select 1 from json_each(new.allows_kind) where value <> 'user')
begin
  select raise(abort, 'a naming predicate may allow only the user kind');
end;

create table if not exists assertion (
  assertion_id     TEXT primary key,
  workspace_id     TEXT not null,
  kind             TEXT not null check (kind in ('capture','inference','user','external')),
  predicate_id     INTEGER not null references predicate(predicate_id),
  subject_ref      TEXT not null,
  object_ref       TEXT,
  object_value     TEXT,
  valid_time       TEXT,
  asserted_at      TEXT not null,
  support_span_ids TEXT not null default '[]',
  produced_by_run  TEXT references pipeline_run(run_id),
  stated_by_user   TEXT,
  external_source  TEXT,
  raw_score        REAL,
  calibration_id   INTEGER,
  calibrated_p     REAL,
  status           TEXT not null default 'active'
                     check (status in ('active','superseded','retracted','disputed','rejected')),
  supersedes       TEXT references assertion(assertion_id),
  emit_key         TEXT not null,
  unique (workspace_id, emit_key),
  -- A model output without evidence is not an inference, it is a rumour.
  constraint inference_support_required check (kind <> 'inference' or support_span_ids <> '[]'),
  constraint capture_support_required   check (kind <> 'capture'   or support_span_ids <> '[]'),
  constraint inference_names_its_run    check (kind <> 'inference' or produced_by_run is not null),
  constraint user_names_its_author      check (kind <> 'user'      or stated_by_user is not null)
);
create index if not exists assertion_lookup_idx on assertion (workspace_id, predicate_id, status);

-- The epistemic guard, mirrored. In Postgres this is tg_assertion_kind_is_allowed(); the rule
-- is expressible here because it is a lookup and a set membership test, and both are portable.
-- What is NOT mirrored is the workspace-context assertion that guard also makes, because there
-- is no session context to assert in a single-process SQLite file.
--
-- Both triggers fail closed by construction: NOT EXISTS is false for an unknown predicate_id,
-- for an empty allows_kind and for a kind absent from it, and every one of those refuses.
create trigger if not exists assertion_kind_is_allowed_insert
before insert on assertion for each row
when not exists (select 1 from predicate p, json_each(p.allows_kind) k
                  where p.predicate_id = new.predicate_id and k.value = new.kind)
begin
  select raise(abort, 'predicate does not accept an assertion of this kind');
end;

-- Guarding only INSERT would leave insert-then-update as an unguarded route to the same row.
create trigger if not exists assertion_kind_is_allowed_update
before update of kind, predicate_id on assertion for each row
when not exists (select 1 from predicate p, json_each(p.allows_kind) k
                  where p.predicate_id = new.predicate_id and k.value = new.kind)
begin
  select raise(abort, 'predicate does not accept an assertion of this kind');
end;

create table if not exists occurrence (
  occurrence_id    TEXT primary key,
  workspace_id     TEXT not null,
  capture_id       TEXT not null references capture(capture_id),
  class            TEXT not null check (class in
                     ('person','voice','place','object','conversation','event')),
  primary_span_id  TEXT not null references evidence_span(span_id),
  span_ids         TEXT not null,
  presence         TEXT not null,
  produced_by_run  TEXT not null references pipeline_run(run_id),
  detector_version TEXT not null,
  quality          TEXT,
  identity_key     BLOB not null check (length(identity_key) = 32),
  emit_key         TEXT not null,
  created_at       TEXT not null,
  unique (workspace_id, emit_key)
);
create index if not exists occurrence_identity_key_idx on occurrence (workspace_id, identity_key);
create index if not exists occurrence_class_idx on occurrence (workspace_id, class);

create table if not exists derived_artifact (
  derived_id   TEXT primary key,
  workspace_id TEXT not null,
  kind         TEXT not null,
  depends_on   TEXT not null,
  dep_index    TEXT not null,
  source_ids   TEXT not null default '[]',
  payload      TEXT,
  computed_at  TEXT not null,
  stale        INTEGER not null default 0
);
create index if not exists derived_artifact_kind_idx on derived_artifact (workspace_id, kind);

create table if not exists tombstone (
  tombstone_id       TEXT primary key,
  workspace_id       TEXT not null,
  scope              TEXT not null check (scope in
                       ('capture','interval','entity','assertion','workspace')),
  capture_id         TEXT,
  track_key          TEXT,
  interval_ns        TEXT,
  entity_id          TEXT,
  assertion_id       TEXT,
  blocklist_hash     INTEGER not null default 0,
  requested_by       TEXT not null,
  requested_at       TEXT not null,
  effective_at       TEXT not null,
  purge_completed_at TEXT,
  reason             TEXT
);
create index if not exists tombstone_capture_idx on tombstone (workspace_id, scope, capture_id);

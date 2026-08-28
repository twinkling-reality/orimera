-- 0001_spine.sql
-- Orimera: the evidence spine, the epistemic layer, identity, provenance, consent, deletion.
--
-- Target: PostgreSQL 18 (uuidv7(), multiranges), pgvector >= 0.8.6, pgcrypto, pg_trgm.
-- Forward-only. There is no down migration: a mistake is corrected by a later forward file.
-- Anything touching the spine uses expand and contract, never an in-place change.
--
-- Reading order: media layer, spine, derivatives, epistemics, identity, provenance, consent,
-- deletion, then the write guards and row-level security which depend on everything above.
--
-- Divergences from docs/domain-and-evidence-model.md are marked "DIVERGENCE" with the reason.
-- Every one of them is a case where the committed SQL does not run, or does not do what the
-- surrounding prose says it does.

begin;

create extension if not exists vector;    -- pgvector >= 0.8.6
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
-- DIVERGENCE, and this one is a hard build error rather than a style point. The committed
-- schema declares gist (blob_sha256, t_range), gist (capture_id, presence) and
-- gist (workspace_id, valid_time) without this extension. Core GiST has no operator class for
-- bytea or uuid, so all three CREATE INDEX statements fail outright. btree_gist supplies them.
create extension if not exists btree_gist;

-- --------------------------------------------------------------------------------------------
-- 0. Migration bookkeeping
-- --------------------------------------------------------------------------------------------

-- The application recomputes the sha-256 of every migration file at boot and refuses to start
-- if a checksum differs from what is recorded here. An edited migration is a silent schema
-- fork, and it is cheaper to refuse to start than to discover it from a wrong answer later.
create table if not exists schema_migrations (
  version      text        primary key,
  checksum     bytea       not null,
  applied_at   timestamptz not null default now(),
  applied_by   text        not null default current_user
);

-- --------------------------------------------------------------------------------------------
-- 1. Closed enumerations
--
-- Only genuinely closed sets are enums. The predicate vocabulary is a lookup table instead,
-- because it churns weekly and ALTER TYPE ... ADD VALUE has awkward transaction semantics.
-- --------------------------------------------------------------------------------------------

create type assertion_kind as enum (
  'capture',    -- a deterministic property of the recording: byte size, dimensions, container
                -- and EXIF timestamps, EXIF GPS, device model, file hash.
  'inference',  -- ANY model output over a capture, however confident: label, caption, OCR,
                -- face embedding, place recognition. A detection is an inference.
  'user',       -- stated by the human. The only kind permitted to carry a name.
  'external'    -- a live-web lookup about a PUBLIC entity. Never a claim about the user's past.
);

create type assertion_status as enum ('active','superseded','retracted','disputed','rejected');

create type occurrence_class as enum ('person','voice','place','object','conversation','event');

create type link_state as enum ('proposed','auto_provisional','confirmed','rejected','revoked');

create type identity_event_type as enum (
  'link_confirmed','link_rejected','link_revoked','entity_created',
  'entities_merged','entity_split','event_undone'
);

create type tombstone_scope as enum ('capture','interval','entity','assertion','workspace');

create type pipeline_event_type as enum (
  'run_started','stage_started','input_resolved','artifact_written','stage_succeeded',
  'stage_failed','retry_scheduled','nondeterminism_detected','assertion_emitted',
  'proposal_emitted','tombstone_applied','run_succeeded','run_failed','run_cancelled'
);

-- --------------------------------------------------------------------------------------------
-- 2. The media layer. Append-only by policy, not immutable: the object store supports no
--    Object Lock, no Legal Hold and no WORM retention, so the guarantee is exactly as strong
--    as the bucket policy that denies DeleteObject to the runtime service account.
-- --------------------------------------------------------------------------------------------

create table blob (
  blob_sha256   bytea primary key check (octet_length(blob_sha256) = 32),
  -- RFC 6920 ni form. translate() with a 3-character source and a 2-character target deletes
  -- '=', which is what strips base64 padding. 32 bytes encode to 44 characters, comfortably
  -- under the 76-character line wrap that encode(...,'base64') would otherwise insert.
  ni_uri        text generated always as
                  ('ni:///sha-256;' ||
                   translate(encode(blob_sha256,'base64'),'+/=','-_')) stored,
  byte_size     bigint not null check (byte_size >= 0),
  media_type    text   not null,
  storage_key   text,                    -- object-store key; NULL once purged
  purged_at     timestamptz,             -- the stub row survives the purge, see section 10
  first_seen_at timestamptz not null default now()
);
-- NOTE: blob is not workspace-scoped, so a purge of shared bytes is global. Harmless while a
-- workspace is one user (assumption A-30); it needs reference counting the day it is not.

create table media_track (
  track_id      uuid primary key default uuidv7(),
  blob_sha256   bytea not null references blob(blob_sha256),
  track_key     text  not null check (track_key ~ '^(img|[va]:(0|[1-9][0-9]{0,3}))$'),
  kind          text  not null check (kind in ('image','video','audio')),

  -- The exact rational anchor. Kept because nanoseconds cannot represent a 1/48000 s tick
  -- exactly, and because a re-probe of the same bytes must be comparable to what was stored.
  time_base_num int    not null check (time_base_num > 0),   -- still image: 1
  time_base_den int    not null check (time_base_den > 0),   -- still image: 1000000000
  start_pts     bigint not null,                             -- still image: 0
  duration_ns   bigint not null check (duration_ns > 0),     -- still image: 1

  coded_w int, coded_h int, disp_w int, disp_h int,
  -- OPEN, and blocking for the v1 freeze: EXIF Orientation has eight values, four of them
  -- mirrored, and this column cannot express a flip. A mirrored original would place
  -- normalised regions on the wrong side of the image, and region is inside span_digest, so a
  -- wrong region becomes a permanent citation address. Ingest refuses mirrored orientations
  -- until this is widened or pixels are normalised at ingest.
  rotation smallint check (rotation in (0,90,180,270)),
  sar_num int, sar_den int,
  codec text not null,
  probe_json jsonb not null,             -- full ffprobe / EXIF output, verbatim
  unique (blob_sha256, track_key)
);

create table capture (
  capture_id   uuid primary key default uuidv7(),
  workspace_id uuid not null,
  blob_sha256  bytea not null references blob(blob_sha256),
  device_id    text,
  started_at   timestamptz,              -- best estimate only; clock_anchor is the real story
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
-- DIVERGENCE from the committed schema, which declares unique (workspace_id, blob_sha256).
-- That constraint contradicts decision del-3: "Re-uploading the same bytes creates a NEW
-- capture_id and proceeds normally." With a total unique constraint the re-upload collides
-- with the tombstoned row and cannot proceed at all. A partial index satisfies both: live
-- duplicates still collapse to one capture, and a deliberate re-import after a deletion gets a
-- fresh capture_id.
create unique index capture_live_bytes_uniq
  on capture (workspace_id, blob_sha256) where deleted_at is null;
create index capture_ws_idx on capture (workspace_id, deleted_at);

-- Wall clock is a separate axis from media time. Media time answers "where in the file",
-- wall clock answers "when in the user's life", and the uncertainty of the join between them
-- is carried into answers rather than rounded away. Device clocks drift; EXIF is editable.
create table clock_anchor (
  anchor_id      uuid primary key default uuidv7(),
  track_id       uuid not null references media_track(track_id),
  t_ns           bigint not null,
  utc_instant    timestamptz not null,
  source         text not null check (source in
                   ('container_creation_time','device_rtc','gps','ntp','user_stated','inferred')),
  uncertainty_ms int not null check (uncertainty_ms >= 0),
  unique (track_id, t_ns, source)
);

-- --------------------------------------------------------------------------------------------
-- 3. The spine. Frozen at v1, extended additively only.
--
-- blob_sha256, track_key, t_start_ns, t_end_ns, the half-open semantics and the
-- nanosecond-to-tick rounding rule may not change. If they ever must, it is a v2 span format
-- written alongside v1, never a rewrite.
-- --------------------------------------------------------------------------------------------

create table evidence_span (
  span_id             uuid primary key default uuidv7(),
  span_format_version smallint not null default 1,
  workspace_id        uuid not null,

  blob_sha256   bytea  not null references blob(blob_sha256),
  track_key     text   not null check (track_key ~ '^(img|[va]:(0|[1-9][0-9]{0,3}))$'),
  t_start_ns    bigint not null,
  t_end_ns      bigint not null,
  t_range       int8range generated always as
                  (int8range(t_start_ns, t_end_ns, '[)')) stored,

  modality      text not null check (modality in
                  ('still_image','frame_region','video_time','audio_time','transcript_text')),
  -- {kind:'rect', rect:{x,y,w,h in parts per million}, display:{w,h,rotation,sar_num,sar_den}}
  -- Coordinates are integers, not floats: region is inside span_digest, and no two JSON
  -- writers agree on how to render a float.
  region        jsonb,
  text_anchor   jsonb,   -- {artifact_id, char_start, char_end, exact, prefix, suffix}
  -- CACHE ONLY. byte offsets break on remux, frame ordinals are a function of the decoder and
  -- the filter graph. Recomputed, never trusted, never part of the address or the digest.
  hint          jsonb,

  span_digest   bytea not null check (octet_length(span_digest) = 32),
  created_at    timestamptz not null default now(),

  -- Half-open and never empty. An empty range contains nothing and overlaps nothing, so the
  -- tombstone interval guard would silently pass it. A photograph carries [0, 1), not [0, 0).
  constraint span_non_empty check (t_end_ns > t_start_ns),
  constraint text_span_needs_anchor check (
    modality <> 'transcript_text' or text_anchor is not null),
  constraint region_span_needs_region check (
    modality <> 'frame_region' or region is not null),
  -- A region makes a span frame_region. Keeping that exclusive is what lets the permalink form
  -- recover the modality from the address shape when the m= parameter is absent.
  constraint region_only_on_frame_region check (
    region is null or modality = 'frame_region'),
  constraint still_image_is_img_track check (
    modality <> 'still_image' or track_key = 'img'),
  constraint video_time_is_video_track check (
    modality <> 'video_time' or track_key like 'v:%'),
  constraint audio_time_is_audio_track check (
    modality <> 'audio_time' or track_key like 'a:%')
);

-- The interval-overlap index. Every co-presence question, every interval tombstone match and
-- every "what else is in this moment" query lands here.
create index evidence_span_range_gist on evidence_span using gist (blob_sha256, t_range);
create index evidence_span_ws_blob_idx on evidence_span (workspace_id, blob_sha256, track_key);
-- The digest is a pure function of the address, so this both deduplicates spans and makes a
-- citation token verifiable without trusting a lookup table that a buggy path could rewrite.
create unique index evidence_span_digest_uniq on evidence_span (workspace_id, span_digest);

-- --------------------------------------------------------------------------------------------
-- 4. Derivatives: idempotent by construction, which is a cost control as much as a
--    correctness one. Re-running the pipeline must not re-bill.
-- --------------------------------------------------------------------------------------------

create table stage_registry (
  stage_key       text primary key,
  current_version int  not null,
  model_ref       jsonb,             -- {provider, model_id, revision, endpoint, dtype}
  params_schema   jsonb not null,
  deterministic   boolean not null default true,
  output_kind     text not null,
  updated_at      timestamptz not null default now()
);

create table pipeline_run (
  run_id       uuid primary key default uuidv7(),
  workspace_id uuid not null,
  capture_id   uuid references capture(capture_id),
  trigger      text not null check (trigger in ('ingest','reprocess','repair','manual')),
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  status       text not null default 'running'
);

create table pipeline_event (
  event_id            uuid primary key default uuidv7(),  -- uuidv7 gives global time ordering
  run_id              uuid not null references pipeline_run(run_id),
  seq                 bigint not null,                    -- gapless per run
  parent_event_id     uuid references pipeline_event(event_id),
  type                pipeline_event_type not null,

  stage_key           text,
  stage_version       int,
  model_ref           jsonb,
  params_digest       bytea,

  -- RECORDED, never implied by the shape of the code. The Assembly Replay must rebuild the
  -- DAG from the ledger alone: a DAG that is only implicit in the source lies as soon as the
  -- source changes, and it lies most convincingly about old runs.
  input_artifact_ids  uuid[] not null default '{}',
  output_artifact_ids uuid[] not null default '{}',
  input_blob_sha256   bytea,

  attempt             int not null default 1,
  max_attempts        int,
  error_class         text,
  error_message       text,

  started_at          timestamptz,
  ended_at            timestamptz,
  duration_ms         int,
  -- {input_tokens, output_tokens, gpu_seconds, usd_estimate}. Per stage, so spend is
  -- attributable rather than arriving as one number at the end of the month.
  cost                jsonb,
  host                text,
  occurred_at         timestamptz not null default now(),
  unique (run_id, seq)
);
create index pipeline_event_run_seq_idx on pipeline_event (run_id, seq);
create index pipeline_event_outputs_gin on pipeline_event using gin (output_artifact_ids);

create table artifact (
  artifact_id        uuid primary key,   -- DETERMINISTIC: uuid_v5(namespace, idempotency_key)
  workspace_id       uuid not null,
  kind               text not null,
  source_blob_sha256 bytea not null references blob(blob_sha256),
  stage_key          text not null,
  stage_version      int  not null,
  params_digest      bytea not null,
  input_digest       bytea not null,     -- sha256 over sorted input artifact content hashes
  idempotency_key    text not null,      -- what the output SHOULD be, computed before running
  content_sha256     bytea,              -- what it TURNED OUT to be, after running
  storage_key        text,
  byte_size          bigint,
  produced_by_event  uuid references pipeline_event(event_id),
  superseded_by      uuid references artifact(artifact_id),
  purged_at          timestamptz,
  needs_repair       boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
-- The two hashes are separate on purpose. If two runs sharing an idempotency_key produce
-- different content_sha256, the stage is nondeterministic, and that is worth an event rather
-- than a silent overwrite. Stages that are legitimately nondeterministic carry
-- deterministic = false in stage_registry, so the event is informational.

create view artifact_current as
  select distinct on (workspace_id, source_blob_sha256, stage_key) *
    from artifact
   where superseded_by is null and purged_at is null
   order by workspace_id, source_blob_sha256, stage_key, stage_version desc;

-- Regenerating a derivative never rewrites a span. This table maps an existing span onto each
-- new artifact version, lazily. A failed re-anchor degrades the highlight; it does not
-- invalidate the citation, because the citation was never the character range.
create table anchor_resolution (
  span_id     uuid not null references evidence_span(span_id),
  artifact_id uuid not null references artifact(artifact_id),
  char_start  int,
  char_end    int,
  method      text not null check (method in
                ('exact_quote','fuzzy_quote','time_overlap','failed')),
  score       real,
  resolved_at timestamptz not null default now(),
  primary key (span_id, artifact_id)
);

-- --------------------------------------------------------------------------------------------
-- 5. Epistemics. Four provenance classes that are never flattened into one.
-- --------------------------------------------------------------------------------------------

create table predicate (
  predicate_id  serial primary key,
  key           text unique not null,
  value_schema  jsonb not null,                   -- JSON Schema for assertion.object_value
  functional    boolean not null default false,   -- at most one active object per subject
  allows_kind   assertion_kind[] not null,        -- name_is allows only 'user'
  -- DIVERGENCE: not in the committed schema. A predicate whose object IS a name. Recorded as a
  -- property of the vocabulary row rather than matched against the key, because the vocabulary
  -- churns weekly (decision epi-3) and a rule spelled as a string comparison is a rule the next
  -- key silently escapes. Whoever adds 'nickname_is' sets this, and the constraint below then
  -- refuses to let a model write it. Without this column the epistemic guard below is one
  -- UPDATE on eleven rows away from being irrelevant.
  writes_a_name boolean not null default false,
  vocab_version int not null default 1,

  -- allows_kind is enforcement, not documentation, so the array itself has to be well formed.
  --
  -- An empty array is deliberately legal and means "no kind may write this predicate", which
  -- is the fail-closed direction: tg_assertion_kind_is_allowed() then refuses every write.
  -- A NULL element is not legal, and this is the subtle one: `k = any(arr)` evaluates to NULL
  -- rather than false when arr holds a NULL and k matches nothing, and a plpgsql `if` on NULL
  -- takes the else branch. One NULL element would therefore turn the guard below into a
  -- no-op. The guard also coalesces, so this constraint is the second of two defences.
  constraint allows_kind_has_no_null_element check (
    array_position(allows_kind, null) is null),
  -- The whole of invariant 4 in one line: only the account holder writes a name.
  constraint a_name_comes_only_from_the_user check (
    not writes_a_name or allows_kind <@ array['user']::assertion_kind[])
);

create table calibration (
  calibration_id serial primary key,
  model_ref      jsonb not null,
  predicate_id   int not null references predicate(predicate_id),
  bin_lo         real not null,
  bin_hi         real not null,
  n_confirmed    int not null default 0,
  n_rejected     int not null default 0,
  empirical_p    real,
  updated_at     timestamptz not null default now()
);

create table assertion (
  assertion_id     uuid primary key default uuidv7(),
  workspace_id     uuid not null,

  kind             assertion_kind not null,
  predicate_id     int  not null references predicate(predicate_id),
  subject_ref      jsonb not null,   -- {type:'entity'|'occurrence'|'capture'|'span', id:...}
  object_ref       jsonb,
  object_value     jsonb,

  -- Bitemporal: when the claim is ABOUT, versus when it was RECORDED.
  valid_time       tstzrange,
  asserted_at      timestamptz not null default now(),

  support_span_ids uuid[] not null default '{}',
  produced_by_run  uuid references pipeline_run(run_id),
  stated_by_user   uuid,
  external_source  jsonb,   -- {url, retrieved_at, snapshot_hash, tool} when kind='external'

  -- Two numbers that are never conflated. raw_score is whatever the model emitted and is never
  -- rendered to a user and never thresholds a factual claim. calibrated_p stays NULL until a
  -- bin has enough observed confirm/reject decisions from this user.
  raw_score        real,
  calibration_id   int references calibration(calibration_id),
  calibrated_p     real,

  status           assertion_status not null default 'active',
  supersedes       uuid references assertion(assertion_id),

  emit_key         text not null,
  constraint assertion_emit_key_uniq unique (workspace_id, emit_key),

  constraint inference_support_required check (
    kind <> 'inference' or cardinality(support_span_ids) > 0),
  constraint capture_support_required check (
    kind <> 'capture' or cardinality(support_span_ids) > 0),
  constraint inference_names_its_run check (
    kind <> 'inference' or produced_by_run is not null),
  constraint user_names_its_author check (
    kind <> 'user' or stated_by_user is not null),
  -- jsonb_exists() rather than the ? operator: identical semantics, and it cannot be mistaken
  -- for a parameter placeholder by a driver that rewrites the statement.
  constraint external_cites_its_source check (
    kind <> 'external' or (jsonb_exists(external_source, 'url')
                       and jsonb_exists(external_source, 'retrieved_at')
                       and jsonb_exists(external_source, 'snapshot_hash'))),
  -- external is structurally barred from supporting a historical clause. It may support only a
  -- present-tense claim about a public entity. Enforced here and again in the answer
  -- validator, never in a prompt.
  constraint external_no_history check (
    kind <> 'external' or valid_time is null
      or lower(valid_time) >= asserted_at - interval '1 day')
);
create index assertion_lookup_idx on assertion (workspace_id, predicate_id, status);
create index assertion_support_gin on assertion using gin (support_span_ids);
create index assertion_valid_time_gist on assertion using gist (workspace_id, valid_time);
create index assertion_subject_gin on assertion using gin (subject_ref jsonb_path_ops);

create table dispute (
  dispute_id   uuid primary key default uuidv7(),
  workspace_id uuid not null,
  assertion_id uuid not null references assertion(assertion_id),
  opened_by    uuid,                -- NULL when opened by the contradiction detector
  reason       text not null,
  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  resolution   text
);

create table retraction (
  retraction_id uuid primary key default uuidv7(),
  workspace_id  uuid not null,
  assertion_id  uuid not null references assertion(assertion_id),
  retracted_by  uuid not null,
  reason        text not null,
  retracted_at  timestamptz not null default now()
);

-- --------------------------------------------------------------------------------------------
-- 6. User annotations.
--
-- UNDER-SPECIFIED in the committed documents: they require that a name comes only from the
-- account holder, that annotations are a revocable consent scope
-- (annotation.attach_user_context), and that annotation text has zero effect on any permission
-- check, but no table is given. Designed here to satisfy those three constraints.
--
-- An annotation is the raw user utterance. It is the SOURCE of a 'user' assertion, not the
-- assertion itself, so that the structured claim and the words the user actually typed stay
-- separable: revoking the annotation scope deletes the text while leaving the audit of what
-- was derived from it. Annotation bodies are untrusted input for prompt-injection purposes and
-- are tagged as such at the trust boundary, not here.
-- --------------------------------------------------------------------------------------------

create table user_annotation (
  annotation_id  uuid primary key default uuidv7(),
  workspace_id   uuid not null,
  author_user_id uuid not null,
  target_ref     jsonb not null,  -- {type:'entity'|'occurrence'|'capture'|'span', id:...}
  span_ids       uuid[] not null default '{}',   -- optional evidence the user pointed at
  body           text not null,
  body_sha256    bytea not null check (octet_length(body_sha256) = 32),
  -- What was derived from this text, so a revocation can invalidate exactly those rows.
  derived_assertion_ids uuid[] not null default '{}',
  created_at     timestamptz not null default now(),
  redacted_at    timestamptz,     -- set when annotation.attach_user_context is revoked
  emit_key       text not null,
  unique (workspace_id, emit_key)
);
create index user_annotation_target_gin on user_annotation using gin (target_ref jsonb_path_ops);
create index user_annotation_spans_gin on user_annotation using gin (span_ids);

-- --------------------------------------------------------------------------------------------
-- 7. Occurrence versus entity.
--
-- An occurrence is scene-local and NEVER carries a name. An entity is workspace-global and
-- carries the name. The link between them is a first-class, reversible, auditable object.
-- If a detector could write a name onto a detection, undo would be impossible and a model's
-- guess would be indistinguishable from the user's knowledge.
-- --------------------------------------------------------------------------------------------

create table occurrence (
  occurrence_id    uuid primary key default uuidv7(),
  workspace_id     uuid not null,
  capture_id       uuid not null references capture(capture_id),
  class            occurrence_class not null,

  primary_span_id  uuid not null references evidence_span(span_id),
  span_ids         uuid[] not null,
  presence         int8multirange not null,   -- union of span intervals, for co-presence math

  produced_by_run  uuid not null references pipeline_run(run_id),
  detector_version text not null,
  quality          jsonb,   -- {blur, area_frac, ...}; drives proposal ranking, not truth

  -- Derived from the EVIDENCE, never from a pipeline row id. This is what makes rejection
  -- memory survive a detector re-run: the next run mints a new occurrence_id for the same face
  -- in the same photograph, but the same identity_key.
  --   sha256(blob_sha256, track_key, floor(t_start/250ms), floor(t_end/250ms), class,
  --          region bucket on a 16x16 grid)
  -- For a photograph both time buckets are 0, so the key reduces to blob, track, class and
  -- region bucket.
  identity_key     bytea not null check (octet_length(identity_key) = 32),
  emit_key         text  not null,
  created_at       timestamptz not null default now(),
  unique (workspace_id, emit_key)
);
create index occurrence_presence_gist on occurrence using gist (capture_id, presence);
create index occurrence_class_idx on occurrence (workspace_id, class);
create index occurrence_identity_key_idx on occurrence (workspace_id, identity_key);
create index occurrence_spans_gin on occurrence using gin (span_ids);

create table entity (
  entity_id    uuid primary key default uuidv7(),
  workspace_id uuid not null,
  class        occurrence_class not null,
  display_name text,                                  -- written ONLY via a 'user' assertion
  merged_into  uuid references entity(entity_id),     -- alias redirect, so old links resolve
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index entity_ws_class_idx on entity (workspace_id, class);
create index entity_merged_into_idx on entity (merged_into) where merged_into is not null;

create table entity_link (
  link_id       uuid primary key default uuidv7(),
  workspace_id  uuid not null,
  occurrence_id uuid not null references occurrence(occurrence_id),
  entity_id     uuid not null references entity(entity_id),
  state         link_state not null,
  method        text not null,   -- 'user_confirm'|'embedding_knn'|'voice_match'|'merge'
  score         real,
  -- sha256(sorted(modalities) || feature_extractor_versions). WHICH signals were shown.
  basis_digest  bytea not null check (octet_length(basis_digest) = 32),
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  -- An auto_provisional link may drive Atlas layout, filtering and "maybe" results. It may
  -- never support a historical factual clause. Only a user decision writes 'confirmed'.
  constraint confirmed_needs_a_human check (
    state <> 'confirmed' or (decided_by is not null and method = 'user_confirm'))
);
create unique index entity_link_one_confirmed
  on entity_link (occurrence_id) where state = 'confirmed';
create index entity_link_entity_idx on entity_link (workspace_id, entity_id, state);
create index entity_link_occurrence_idx on entity_link (workspace_id, occurrence_id, state);

-- Candidate decisions, ranked, before any link exists. Kept even when dropped below the low
-- threshold: "we considered and discarded this" is part of the audit.
create table match_proposal (
  proposal_id   uuid primary key default uuidv7(),
  workspace_id  uuid not null,
  occurrence_id uuid not null references occurrence(occurrence_id),
  entity_id     uuid not null references entity(entity_id),
  score         real not null,
  rank          int  not null,
  basis_digest  bytea not null check (octet_length(basis_digest) = 32),
  basis         jsonb not null,   -- {modalities:[...], extractor_versions:{...}}
  outcome       text not null check (outcome in
                  ('auto_linked','surfaced','dropped','suppressed_by_rejection',
                   'suppressed_by_constraint')),
  produced_by_run uuid not null references pipeline_run(run_id),
  created_at    timestamptz not null default now(),
  emit_key      text not null,
  unique (workspace_id, emit_key)
);
create index match_proposal_occurrence_idx on match_proposal (workspace_id, occurrence_id, rank);

-- Rejection memory. Keyed by the evidence-derived identity_key, never by a pipeline row id.
-- Keying by occurrence_id is the obvious design and it resurrects every rejected proposal on
-- every detector re-run, which is what makes the product feel broken.
create table identity_rejection (
  rejection_id uuid primary key default uuidv7(),
  workspace_id uuid not null,
  scope        text  not null check (scope in ('occurrence_entity','entity_entity')),
  key_a        bytea not null,   -- occurrence identity_key, or entity_id bytes
  key_b        bytea not null,   -- entity_id bytes
  basis_digest bytea not null check (octet_length(basis_digest) = 32),
  rejected_by  uuid  not null,
  rejected_at  timestamptz not null default now(),
  revoked_at   timestamptz,      -- undo is a revocation, never a DELETE
  unique (workspace_id, scope, key_a, key_b, basis_digest)
);
create index identity_rejection_lookup_idx
  on identity_rejection (workspace_id, scope, key_a, key_b) where revoked_at is null;

-- An explicit "these two are not the same" constraint, written by a split.
create table never_same (
  workspace_id uuid not null,
  entity_a     uuid not null references entity(entity_id),
  entity_b     uuid not null references entity(entity_id),
  created_by_event uuid,
  created_at   timestamptz not null default now(),
  -- Stored with entity_a < entity_b so the pair has one representation.
  constraint never_same_ordered check (entity_a < entity_b),
  primary key (workspace_id, entity_a, entity_b)
);

-- Merge, split, confirm, reject and undo are EVENTS, not mutations. The ledger is the truth.
create table identity_event (
  event_id     uuid primary key default uuidv7(),
  workspace_id uuid not null,
  type         identity_event_type not null,
  actor        uuid not null,
  -- merge: {from:[a,b], into:c, links:[...]}  split: the full partition of occurrence ids.
  -- The exact link set at merge time is what makes undo exact rather than approximate.
  payload      jsonb not null,
  undoes       uuid references identity_event(event_id),
  created_at   timestamptz not null default now()
);
create index identity_event_ws_idx on identity_event (workspace_id, created_at desc);

-- Every derived object records what it depends on, so invalidation is mechanical rather than a
-- hand-maintained list of things to remember.
create table derived_artifact (
  derived_id   uuid primary key default uuidv7(),
  workspace_id uuid not null,
  kind         text not null,   -- 'entity_exemplars'|'cooccurrence_edge'|'atlas_layout'
                                -- |'episode_summary'|'answer_cache'
  depends_on   jsonb not null,  -- [{kind:'entity', id, v}, ...]
  dep_index    text[] not null, -- flattened 'entity:<uuid>' strings
  -- Every generated summary records the source id set it was conditioned on, so a generated
  -- title naming a person can be invalidated when that person is deleted. Without it, the name
  -- survives its own deletion inside a caption.
  source_ids   uuid[] not null default '{}',
  payload      jsonb,
  computed_at  timestamptz not null default now(),
  stale        boolean not null default false
);
create index derived_artifact_dep_gin on derived_artifact using gin (dep_index);
create index derived_artifact_source_gin on derived_artifact using gin (source_ids);

-- --------------------------------------------------------------------------------------------
-- 8. Embeddings and the lexical arm.
--
-- ANN is used for recall and ranking only, never for set membership. "Which people are in this
-- photograph" is answered relationally from confirmed entity_link rows. An approximate index
-- may not decide a factual claim.
-- --------------------------------------------------------------------------------------------

-- DIVERGENCE on dimensionality. The committed schema says halfvec(1024). Runtime verification measured the
-- only embedding-typed model in the catalog, Qwen/Qwen3-Embedding-8B, returning 4096
-- dimensions, and runtime-verification.md overrides on conflict. pgvector indexes halfvec to at most
-- 4000 dimensions, so a 4096-dimension column cannot carry an HNSW or IVFFlat index at all.
-- Decision: store the model's real output width and run exact search. At personal-library
-- scale (thousands of vectors, not millions) exact search is both fast enough and strictly
-- more correct than an approximate index, and it sidesteps the documented overfiltering
-- hazard entirely. If scale later demands ANN, the additive path is a second column holding a
-- Matryoshka-truncated, renormalised 1024-dimension prefix used for recall only, added by a
-- later migration; it is not added now because the truncation support of this endpoint is
-- unverified.
--
-- Two consequences of that decision are made explicit rather than left to be inferred from the
-- absence of a statement, because "there is no index here" reads as an oversight otherwise:
--   *  There is deliberately NO index on v. Search over this column is exact, sequential and
--      correct. At personal-library scale that is the right trade, and pgvector could not
--      build the index at this width even if it were wanted.
--   *  dims is checked against the width of v rather than merely recorded next to it. It
--      exists so a row states the width it was written at; a row claiming a width the column
--      cannot hold is a bug, not a variant.
create table embedding (
  embedding_id     uuid not null default uuidv7(),
  workspace_id     uuid not null,
  family           text not null,   -- 'text_chunk'|'visual_segment'|'face'|'speaker'
  ref_type         text not null check (ref_type in ('span','occurrence','entity')),
  ref_id           uuid not null,
  model_ref        text not null,
  pipeline_version int  not null,
  -- VERIFIED by runtime measurement: Qwen/Qwen3-Embedding-8B returns 4096 dimensions. Not 1024.
  dims             int  not null check (dims = 4096),
  v                halfvec(4096) not null,
  created_at       timestamptz not null default now(),
  primary key (workspace_id, embedding_id)
) partition by list (workspace_id);
-- Partitioning by workspace makes tenancy a partition prune rather than a post-scan filter,
-- and it is also, by construction, the namespace isolation the privacy analysis requires.
-- Per-workspace partitions are created by the workspace provisioning path:
--   create table embedding_ws_<slug> partition of embedding for values in ('<uuid>');
--   create index on embedding_ws_<slug> (family, ref_type, ref_id);

create table text_chunk (
  chunk_id     uuid primary key default uuidv7(),
  workspace_id uuid not null,
  span_id      uuid not null references evidence_span(span_id),
  artifact_id  uuid not null references artifact(artifact_id),
  body         text not null,
  tsv          tsvector generated always as (to_tsvector('simple', body)) stored
);
create index text_chunk_tsv_gin on text_chunk using gin (tsv);
create index text_chunk_trgm_gin on text_chunk using gin (body gin_trgm_ops);
create index text_chunk_span_idx on text_chunk (workspace_id, span_id);

-- --------------------------------------------------------------------------------------------
-- 9. Consent. Deny by default: absence of a record is denial, not "undecided".
--    Append-only with a hash chain. Revocation is a new superseding record, never an update.
-- --------------------------------------------------------------------------------------------

create table consent_record (
  consent_id            uuid primary key default uuidv7(),
  tenant_id             uuid not null,
  subject_ref           uuid not null,   -- stable pseudonymous subject key
  subject_person_id     uuid,            -- resolved entity; NULL until linked
  subject_label         text not null,   -- a user-supplied label, not identity proof

  grant_mode            text not null
    check (grant_mode in ('subject_signed','operator_attested')),
  -- The account holder cannot consent for anyone else. operator_attested is a weaker record
  -- carrying strictly fewer downstream permissions, and demo.* scopes are forbidden in it.
  identity_channel      text not null
    check (identity_channel in ('email_challenge','sms_challenge',
                                'in_person_video_attestation','countersigned_pdf')),
  identity_value_hash   bytea not null,   -- HMAC of email/phone under a per-tenant key
  revocation_code_hash  bytea not null,   -- the subject can revoke without us storing a secret

  scopes                text[] not null,  -- absence of a token means denied
  purpose_text          text not null,
  notice_text_sha256    bytea not null,   -- the EXACT wording shown, hashed
  notice_version        text not null,
  notice_locale         text not null,

  granted_at            timestamptz not null,
  expires_at            timestamptz not null,   -- mandatory; consent expires
  jurisdiction_claimed  text,
  adult_attested        boolean not null check (adult_attested = true),

  evidence_blob_ref     text,
  evidence_sha256       bytea,

  revoked_at            timestamptz,
  revocation_actor      text check (revocation_actor in
                          ('subject','account_owner','operator','automatic_expiry')),
  revocation_reason     text,
  supersedes            uuid references consent_record(consent_id),

  prev_record_hash      bytea,
  record_hash           bytea not null,

  constraint operator_attested_has_no_demo_scopes check (
    grant_mode <> 'operator_attested'
    or not (scopes && array['demo.public_replay','demo.public_still'])),
  constraint expiry_after_grant check (expires_at > granted_at)
);
create index consent_record_subject_idx
  on consent_record (tenant_id, subject_ref, granted_at desc);
create index consent_record_person_idx
  on consent_record (tenant_id, subject_person_id) where subject_person_id is not null;

-- Effective consent, joined by every read path. A revoked or expired person disappears from
-- results the instant the row lands, before any async cleanup has run.
create view consent_effective as
  select distinct on (tenant_id, subject_ref)
         consent_id, tenant_id, subject_ref, subject_person_id, grant_mode, scopes,
         granted_at, expires_at, revoked_at
    from consent_record
   where revoked_at is null and expires_at > now()
   order by tenant_id, subject_ref, granted_at desc;

-- --------------------------------------------------------------------------------------------
-- 10. Deletion. Tombstones are authoritative, monotonic, never deleted and never expired.
-- --------------------------------------------------------------------------------------------

create table tombstone (
  tombstone_id       uuid primary key default uuidv7(),
  workspace_id       uuid not null,
  scope              tombstone_scope not null,
  capture_id         uuid,
  track_key          text,
  interval_ns        int8multirange,   -- for scope='interval'
  entity_id          uuid,
  assertion_id       uuid,
  -- A capture tombstone is keyed by capture_id, never by blob hash. A hash-keyed tombstone
  -- permanently blocklists those exact bytes, so a user who deleted something and later
  -- deliberately re-imported it would be silently blocked with no way to explain why.
  -- "Never let this content back in" is a different intent and needs an explicit opt-in.
  blocklist_hash     boolean not null default false,
  requested_by       uuid not null,
  requested_at       timestamptz not null default now(),
  effective_at       timestamptz not null default now(),
  purge_completed_at timestamptz,
  reason             text,
  constraint interval_scope_is_complete check (
    scope <> 'interval' or (capture_id is not null
                            and track_key is not null
                            and interval_ns is not null)),
  constraint capture_scope_names_a_capture check (
    scope <> 'capture' or capture_id is not null),
  constraint entity_scope_names_an_entity check (
    scope <> 'entity' or entity_id is not null)
);
create index tombstone_capture_idx on tombstone (workspace_id, scope, capture_id);
create index tombstone_interval_gist
  on tombstone using gist (capture_id, interval_ns) where scope = 'interval';
create index tombstone_entity_idx
  on tombstone (workspace_id, entity_id) where entity_id is not null;
create index tombstone_workspace_scope_idx
  on tombstone (workspace_id) where scope = 'workspace';

-- The object-store purge runs after commit and is driven by this table, so a crashed purge
-- resumes rather than being lost.
create table purge_job (
  purge_id     uuid primary key default uuidv7(),
  tombstone_id uuid not null references tombstone(tombstone_id),
  workspace_id uuid not null,
  target_kind  text not null check (target_kind in ('blob','artifact','embedding','text_chunk')),
  target_ref   text not null,
  state        text not null default 'queued'
                 check (state in ('queued','running','done','failed')),
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (tombstone_id, target_kind, target_ref)
);
create index purge_job_queue_idx on purge_job (state, created_at) where state = 'queued';

create table job (
  job_id       uuid primary key default uuidv7(),
  workspace_id uuid not null,
  kind         text not null,
  payload      jsonb not null,
  state        text not null default 'queued'
                 check (state in ('queued','running','done','failed','cancelled')),
  priority     int  not null default 100,
  run_after    timestamptz not null default now(),
  claimed_by   text,
  claimed_at   timestamptz,
  attempts     int not null default 0,
  last_error   text,
  capture_id   uuid references capture(capture_id),
  created_at   timestamptz not null default now()
);
-- Claiming uses: select ... where state='queued' and run_after <= now()
--                order by priority, job_id for update skip locked limit 1
create index job_queue_idx on job (state, run_after, priority, job_id) where state = 'queued';

-- --------------------------------------------------------------------------------------------
-- 11. The write guards: the tombstone guard, then the epistemic guard on assertion.
--
-- Application-level checks are not sufficient: retries arrive from stale workers holding
-- pre-deletion state. The guard fires inside the writing transaction and reads the committed
-- tombstone table, so a worker that checked before the tombstone committed still fails at
-- insert. Workers treat this error class as terminal and non-retryable.
--
-- DIVERGENCE from the committed function, which is a single polymorphic trigger reading
-- NEW.capture_id, NEW.entity_id, NEW.track_key and NEW.t_start_ns. That function cannot run:
-- plpgsql raises "record NEW has no field capture_id" the first time it fires on
-- evidence_span, which has none of those columns, and the same for assertion and embedding.
-- Replaced here by one shared predicate plus a small typed trigger per table shape.
-- --------------------------------------------------------------------------------------------

-- The session's declared workspace. A missing setting yields NULL, which matches no row: the
-- row-level security policies in section 12 and the guard assertion below are both default-deny
-- because of it.
create or replace function current_workspace() returns uuid
language sql stable as $fn$
  select nullif(current_setting('orimera.workspace_id', true), '')::uuid;
$fn$;

-- Does a committed tombstone cover this address?
--
-- The capture-scope branch deliberately releases once some live capture in the workspace
-- claims these bytes again. That is what reconciles the guard with the re-upload rule: a
-- deliberate re-import creates a new live capture, and derivatives of the new capture proceed.
-- An interval redaction is NOT released that way, because an interval tombstone is a statement
-- about content rather than about one import of it, and deletion is monotonic.
create or replace function tombstone_blocks_span(
  p_workspace uuid,
  p_blob      bytea,
  p_track     text,
  p_start_ns  bigint,
  p_end_ns    bigint
) returns boolean
-- VOLATILE, not STABLE, and deliberately so. Under READ COMMITTED a stable function reuses the
-- statement snapshot, so a tombstone that commits while this INSERT is running would not be
-- seen. A volatile function takes a fresh snapshot per call, which narrows the
-- time-of-check-to-time-of-use window to the smallest the isolation level allows. The cost is
-- that it cannot be inlined; at this write volume that is not a consideration.
language sql volatile as $fn$
  select exists (
    select 1
      from tombstone t
      left join capture c on c.capture_id = t.capture_id
     where t.workspace_id = p_workspace
       and t.effective_at <= now()
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

create or replace function tombstone_blocks_any_span(p_workspace uuid, p_span_ids uuid[])
returns boolean
language sql volatile as $fn$
  select exists (
    select 1
      from evidence_span s
     where s.span_id = any(p_span_ids)
       and tombstone_blocks_span(p_workspace, s.blob_sha256, s.track_key,
                                 s.t_start_ns, s.t_end_ns)
  );
$fn$;

create or replace function tombstone_blocks_capture(p_workspace uuid, p_capture uuid)
returns boolean
language sql volatile as $fn$
  select exists (
    select 1 from tombstone t
     where t.workspace_id = p_workspace
       and t.effective_at <= now()
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
       and t.effective_at <= now()
       and (t.scope = 'workspace' or (t.scope = 'entity' and t.entity_id = p_entity))
  );
$fn$;

-- The guards read tombstone, evidence_span and occurrence, all of which carry FORCE row-level
-- security. A session that never set orimera.workspace_id sees those tables as empty, so the
-- guard would find no tombstone and fail OPEN, which is the worst possible direction for it to
-- fail in. A role holding BYPASSRLS reaches the same place from the other side: RLS is skipped,
-- but nothing checks that the row belongs to the session's workspace.
--
-- Triggers are not bypassed by BYPASSRLS, so asserting the context here is strictly stronger
-- than the WITH CHECK clause on the policy. A guarded write now requires the session to have
-- declared which workspace it is writing for, and to be writing for that one.
create or replace function assert_workspace_context(p_workspace uuid) returns void
language plpgsql as $fn$
begin
  if current_workspace() is distinct from p_workspace then
    raise exception
      'workspace context missing or mismatched: set orimera.workspace_id to % before writing',
      p_workspace
      using errcode = 'insufficient_privilege';
  end if;
end $fn$;

create or replace function tombstone_refuse(p_what text) returns void
language plpgsql as $fn$
begin
  raise exception 'tombstoned: write refused for %', p_what
    using errcode = 'integrity_constraint_violation';
end $fn$;

create or replace function tg_tombstone_guard_span() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if tombstone_blocks_span(new.workspace_id, new.blob_sha256, new.track_key,
                           new.t_start_ns, new.t_end_ns) then
    perform tombstone_refuse('evidence_span');
  end if;
  return new;
end $fn$;

create or replace function tg_tombstone_guard_occurrence() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if tombstone_blocks_capture(new.workspace_id, new.capture_id)
     or tombstone_blocks_any_span(new.workspace_id, new.span_ids) then
    perform tombstone_refuse('occurrence');
  end if;
  return new;
end $fn$;

create or replace function tg_tombstone_guard_assertion() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if tombstone_blocks_any_span(new.workspace_id, new.support_span_ids) then
    perform tombstone_refuse('assertion');
  end if;
  if new.subject_ref->>'type' = 'entity'
     and tombstone_blocks_entity(new.workspace_id, (new.subject_ref->>'id')::uuid) then
    perform tombstone_refuse('assertion');
  end if;
  if exists (select 1 from tombstone t
              where t.workspace_id = new.workspace_id
                and t.effective_at <= now()
                and t.scope = 'workspace') then
    perform tombstone_refuse('assertion');
  end if;
  return new;
end $fn$;

create or replace function tg_tombstone_guard_embedding() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if new.ref_type = 'span' and tombstone_blocks_any_span(new.workspace_id, array[new.ref_id]) then
    perform tombstone_refuse('embedding');
  end if;
  if new.ref_type = 'entity' and tombstone_blocks_entity(new.workspace_id, new.ref_id) then
    perform tombstone_refuse('embedding');
  end if;
  if new.ref_type = 'occurrence' and exists (
       select 1 from occurrence o
        where o.occurrence_id = new.ref_id
          and (tombstone_blocks_capture(o.workspace_id, o.capture_id)
               or tombstone_blocks_any_span(o.workspace_id, o.span_ids))) then
    perform tombstone_refuse('embedding');
  end if;
  if exists (select 1 from tombstone t
              where t.workspace_id = new.workspace_id
                and t.effective_at <= now()
                and t.scope = 'workspace') then
    perform tombstone_refuse('embedding');
  end if;
  return new;
end $fn$;

create or replace function tg_tombstone_guard_entity_link() returns trigger
language plpgsql as $fn$
begin
  perform assert_workspace_context(new.workspace_id);
  if tombstone_blocks_entity(new.workspace_id, new.entity_id) then
    perform tombstone_refuse('entity_link');
  end if;
  return new;
end $fn$;

create trigger tg_guard_span       before insert on evidence_span
  for each row execute function tg_tombstone_guard_span();
create trigger tg_guard_occurrence before insert on occurrence
  for each row execute function tg_tombstone_guard_occurrence();
create trigger tg_guard_assertion  before insert on assertion
  for each row execute function tg_tombstone_guard_assertion();
create trigger tg_guard_embedding  before insert on embedding
  for each row execute function tg_tombstone_guard_embedding();
-- Added beyond the four named in the domain document: without it an entity-scope tombstone has
-- nowhere to bite, because no other guarded table carries entity_id in a column.
create trigger tg_guard_entity_link before insert on entity_link
  for each row execute function tg_tombstone_guard_entity_link();

-- --------------------------------------------------------------------------------------------
-- The epistemic guard.
--
-- DIVERGENCE, and it is the most serious one in this file. The committed schema declares
-- predicate.allows_kind with no CHECK, no foreign key and no trigger, and then annotates the
-- seed with "there is no code path in which a model writes a name". A live probe on the
-- committed schema accepted
--     insert into assertion (kind='inference', predicate_id=name_is,
--                            object_value='"Aunt Marjorie"')
-- with status='active', and accepted a caption filed as kind='capture'. Every other epistemic
-- rule in this file is a CHECK or a trigger and every one of them fires. That one was data,
-- and data enforces nothing. This section makes allows_kind mean what the comment claims.
--
-- Why a trigger, having considered the alternatives:
--
--   *  A CHECK constraint cannot do it. The permitted set lives in another table, and
--      PostgreSQL rejects a subquery in a CHECK outright rather than evaluating it wrongly.
--   *  A composite foreign key would work: normalise allows_kind into
--      predicate_allowed_kind (predicate_id, kind) and give assertion a foreign key onto it.
--      That is declarative, and it is genuinely tempting. It was rejected because it stores
--      the vocabulary twice, and keeping the array and the junction table in step is itself a
--      trigger. The trigger does not disappear, it moves from the table that is written once
--      per claim to the table that churns weekly, which is the worse place for it.
--   *  A trigger can additionally assert the session's workspace context, which neither of the
--      other two can. One mechanism then carries both rules, and a write with no declared
--      workspace is refused rather than merely unfiltered.
--
-- Bypass surface is the same for all three: a trigger and a foreign key are both skipped only
-- under session_replication_role = 'replica' (superuser) or by DDL that drops them.
create or replace function tg_assertion_kind_is_allowed() returns trigger
language plpgsql as $fn$
declare
  v_key    text;
  v_allows assertion_kind[];
begin
  -- Same reasoning as the tombstone guards, and it applies here for a second reason too: a
  -- write that has not declared its workspace has no business landing in one.
  perform assert_workspace_context(new.workspace_id);

  select p.key, p.allows_kind into v_key, v_allows
    from predicate p
   where p.predicate_id = new.predicate_id;

  -- FAIL CLOSED on everything that is not an explicit permission. Three cases reach here:
  --   *  no predicate row at all. A BEFORE trigger runs ahead of the foreign key check, so
  --      this is reachable rather than theoretical, and it must refuse rather than skip.
  --   *  a permitted set that does not contain this kind.
  --   *  an ANY that returns NULL. coalesce() is load bearing, not decoration:
  --      `k = any(arr)` is NULL, not false, when arr holds a NULL element and k matches
  --      nothing else, and plpgsql takes the else branch on a NULL condition. Without the
  --      coalesce a single NULL in allows_kind would silently disarm this whole function.
  --      predicate.allows_kind_has_no_null_element stops that array existing; this stops it
  --      mattering if it ever does.
  if v_allows is null or not coalesce(new.kind = any(v_allows), false) then
    raise exception 'predicate % does not accept a % assertion; it allows %',
      coalesce(v_key, '#' || new.predicate_id::text),
      new.kind,
      coalesce(v_allows::text, '(no such predicate)')
      using errcode = 'integrity_constraint_violation',
            hint = 'A detection is an inference however confident it is, and a name is '
                   'written only by the account holder.';
  end if;
  return new;
end $fn$;

-- INSERT and UPDATE both. Guarding only INSERT would leave
--     insert (kind='user') then update set kind='inference'
-- as an unguarded two-step route to exactly the row the guard exists to refuse. The column
-- list is not a weakening: kind and predicate_id are the only two inputs to the decision, so
-- an update that violates the rule must have written one of them.
--
-- KNOWN AND ACCEPTED: narrowing a predicate's allows_kind later does not retro-invalidate
-- assertions already written under the wider vocabulary. Those rows are history, and history
-- is corrected by a retraction, not by a schema edit that silently rewrites the past.
create trigger tg_assertion_kind_is_allowed
  before insert or update of kind, predicate_id on assertion
  for each row execute function tg_assertion_kind_is_allowed();

-- --------------------------------------------------------------------------------------------
-- 12. Row-level security.
--
-- ENABLE alone is not enough: table owners bypass RLS unless FORCE is also set, and any role
-- with BYPASSRLS always bypasses it. The query executor connects as a role that owns nothing
-- and does not hold BYPASSRLS. An executor connecting as the table owner makes every policy
-- here silently inert, which is the failure this comment exists to prevent.
-- --------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'capture','evidence_span','artifact','assertion','dispute','retraction',
    'user_annotation','occurrence','entity','entity_link','match_proposal',
    'identity_rejection','never_same','identity_event','derived_artifact',
    'text_chunk','tombstone','purge_job','job','pipeline_run'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format(
      'create policy ws_isolation on %I using (workspace_id = current_workspace()) '
      'with check (workspace_id = current_workspace())', t);
  end loop;
end $$;

-- embedding is partitioned; RLS is declared on the parent and inherited by partitions.
alter table embedding enable row level security;
alter table embedding force  row level security;
create policy ws_isolation on embedding
  using (workspace_id = current_workspace())
  with check (workspace_id = current_workspace());

-- consent_record is tenant-scoped rather than workspace-scoped.
alter table consent_record enable row level security;
alter table consent_record force  row level security;
create policy tenant_isolation on consent_record
  using (tenant_id = nullif(current_setting('orimera.tenant_id', true), '')::uuid);

-- --------------------------------------------------------------------------------------------
-- 13. Seed vocabulary.
--
-- What allows_kind now means, stated precisely, because the previous wording here claimed a
-- guarantee the schema did not provide:
--
--   *  tg_assertion_kind_is_allowed() refuses, inside the writing transaction, any assertion
--      whose kind is absent from its predicate's allows_kind, on insert and on any update that
--      touches kind or predicate_id. name_is allows only 'user', so an insert of a name under
--      kind='inference' raises rather than landing with status='active'. caption_is and
--      ocr_text_is allow only 'inference', so a model output cannot be filed as a
--      capture-supported fact.
--   *  predicate.a_name_comes_only_from_the_user refuses a vocabulary row that marks itself
--      writes_a_name while permitting any kind other than 'user'. The rule therefore survives
--      the vocabulary churn that decision epi-3 anticipates: a later 'nickname_is' cannot be
--      seeded as model-writable.
--   *  person_present allows inference, because a detection is an inference no matter how
--      confident it is (decision epi-1). What the detector may NOT do is name the person, and
--      that is the line the two rules above draw.
--
-- The guarantee stops at the database boundary and is not claimed beyond it: a role holding
-- DDL rights can drop a trigger, and a superuser session under
-- session_replication_role = 'replica' skips triggers and foreign keys alike. Neither is a
-- path the runtime service account has.
-- --------------------------------------------------------------------------------------------

insert into predicate (key, value_schema, functional, allows_kind, writes_a_name) values
  ('name_is',        '{"type":"string","maxLength":200}',            true,
     '{user}',             true),
  ('person_present', '{"type":"null"}',                              false,
     '{inference,user}',   false),
  ('object_present', '{"type":"string"}',                            false,
     '{inference,user}',   false),
  ('place_is',       '{"type":"string"}',                            true,
     '{inference,user}',   false),
  ('captured_at',    '{"type":"string","format":"date-time"}',       true,
     '{capture,user}',     false),
  ('device_model_is','{"type":"string"}',                            true,
     '{capture}',          false),
  ('gps_position_is','{"type":"object","required":["lat","lon"]}',   true,
     '{capture,user}',     false),
  ('pixel_size_is',  '{"type":"object","required":["w","h"]}',       true,
     '{capture}',          false),
  ('caption_is',     '{"type":"string"}',                            false,
     '{inference}',        false),
  ('ocr_text_is',    '{"type":"string"}',                            false,
     '{inference}',        false),
  ('public_entity_status_is', '{"type":"string"}',                   false,
     '{external}',         false);

commit;

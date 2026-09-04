-- 0019_evaluation_model_attempts.sql
--
-- A terminal model-backed stage recorded the model that answered and the total request count, but
-- not the ordered model identifiers attempted before the answer. The vision artifact retained that
-- list, yet a ledger-only evaluation archive could not prove a fallback occurred without opening a
-- derived payload. Keep the attempted identifiers on the event that already owns attempt and cost.
-- Historical rows remain NULL because their exact attempted chain cannot be reconstructed safely.

begin;

select pg_advisory_xact_lock(119622309);

alter table pipeline_event
  add column models_tried text[],
  add constraint pipeline_event_models_tried_nonempty
    check (models_tried is null or cardinality(models_tried) > 0);

comment on column pipeline_event.models_tried is
  'Ordered model identifiers attempted by this stage call. NULL means no model call or unavailable historical data; never infer it from the current manifest.';

commit;

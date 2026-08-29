-- 0008_match_proposals_from_context.sql
-- What a rejection was shown, so a genuinely different signal set may ask again.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- Nothing has ever written `match_proposal`. Identity has been rung one: the account holder says
-- who somebody is. This migration is the schema half of the second rung, which is proposals built
-- from context and never from biometrics. No face, no voice, no gait: those have no producer and
-- the decision that would permit one belongs to a human (privacy-consent-threat-model.md
-- section 10) and has not been made.
--
-- ---------------------------------------------------------------------------------------------
-- THE DEFECT THIS FIXES, which is not on the register because nothing had exercised it yet.
--
-- Invariant 3: "A rejected match must never be re-proposed identically." Decision id-4 states the
-- rule as a SUBSET test: a new proposal is suppressed when its basis is a subset of a rejected
-- basis. `identity_rejection` stores `basis_digest bytea` and no modality list, and a digest is
-- opaque, so a subset cannot be tested on one. `IdentityRepository.is_rejected` therefore
-- implements the degenerate case, digest EQUALITY, which is under-suppression in the dangerous
-- direction.
--
-- `basis_digest` covers `extractor_versions` on purpose, and that reasoning is right for "was
-- this the same signal set". It means a producer version bump moves the digest while the modality
-- set stands still, and every rejected proposal comes back. The user re-answers a question they
-- already answered, which is the failure invariant 3 names, arriving through the door the digest
-- was supposed to lock. `basis_digest`'s own docstring makes this argument about scores: "keying
-- on it would make every reranking a licence to re-ask." A version integer is the same hazard.
--
-- So the modality set is stored beside the digest, and the suppression test becomes `<@`, which
-- is literally "is a subset of", which is literally id-4.
-- ---------------------------------------------------------------------------------------------

begin;

-- Serialise against a concurrent applier, with the same key every migration uses.
select pg_advisory_xact_lock(119622309);

-- A CHECK constraint may not contain a subquery, and PostgreSQL says so plainly: the obvious
-- `= (select array_agg(m order by m) from unnest(...))` is refused with "cannot use subquery in
-- check constraint". So normalisation is a function, and it has to be IMMUTABLE to be usable
-- from one.
create or replace function sorted_distinct(a text[]) returns text[]
language sql immutable strict parallel safe as $fn$
  select array_agg(m order by m) from (select distinct unnest(a) as m) s
$fn$;

comment on function sorted_distinct(text[]) is
  'Sorted, distinct. Two spellings of one modality set must compare equal, or a rejection would '
  'fail to suppress the proposal it was an answer to and the user would be asked twice.';

-- --------------------------------------------------------------------------------------------
-- 1. What the rejection was shown.
--
-- NULLABLE, WITH NO DEFAULT, AND THE NULL IS LOAD BEARING. A user who looked at their own
-- photograph and said "that is not them" has NO machine basis, which is a different fact from an
-- EMPTY machine basis. `'{}'` contains nothing, so `X <@ '{}'` is false for every non-empty X and
-- an empty array would suppress nothing at all: a GPS coincidence would be permitted to overrule
-- a person's own eyes about their own life. NULL, read through the `is null or` guard in the
-- predicate below, suppresses everything.
--
-- A zero must say which zero it is.
alter table identity_rejection add column basis_modalities text[];

comment on column identity_rejection.basis_modalities is
  'The id-4 modalities the user was shown when they said no, normalised sorted and distinct. '
  'NULL means they were shown no machine signal at all and spoke unprompted, which suppresses '
  'every later proposal for the pair. An empty array would suppress none and is refused.';

alter table identity_rejection
  add constraint rejection_modalities_are_the_closed_vocabulary check (
    basis_modalities is null or basis_modalities <@ array[
      'face', 'voice', 'gait', 'context_place', 'context_cooccurrence', 'user_text'
    ]::text[]);

-- The vocabulary is closed and the check is where it closes. `embedding_knn` is exactly what
-- `entity_link.method` offers as an example and exactly the wrong thing to write here, and it is
-- refused. The same six strings appear in `orimera.identity.keys.BASIS_VOCABULARY`; a seventh
-- added there and not here is refused by the database on its first write rather than accepted and
-- discovered later, which is R4's lesson applied to a second vocabulary.

alter table identity_rejection
  add constraint rejection_modalities_are_normalised check (
    basis_modalities is null or basis_modalities = sorted_distinct(basis_modalities));

-- Empty is refused rather than treated as NULL, because the two mean opposite things above and
-- silently converting one into the other is how the distinction stops being real.
alter table identity_rejection
  add constraint rejection_modalities_are_not_empty check (
    basis_modalities is null or cardinality(basis_modalities) > 0);

create index identity_rejection_modalities_gin
  on identity_rejection using gin (basis_modalities);

-- --------------------------------------------------------------------------------------------
-- 2. What the proposal is offering that the user has not already refused.
--
-- id-4 permits a proposal whose basis is not a subset of a rejected one, and requires the
-- interface to say what is new about it. The producer is what knows, so the producer records it
-- rather than a read recomputing it.
alter table match_proposal add column new_modality text;

alter table match_proposal
  add constraint proposal_new_modality_is_the_closed_vocabulary check (
    new_modality is null or new_modality = any(array[
      'face', 'voice', 'gait', 'context_place', 'context_cooccurrence', 'user_text'
    ]::text[]));

comment on column match_proposal.new_modality is
  'The modality this proposal carries that the user has not already refused for this pair, or '
  'NULL when nothing about the pair was refused before. It is what lets an interface say why it '
  'is asking again rather than appearing to nag.';

-- --------------------------------------------------------------------------------------------
-- 3. Which proposals are still questions. One definition, several readers.
--
-- `outcome` records what the PRODUCER decided. Whether the question is still open is a fact about
-- the USER's later decisions, so pending is derived rather than stored. Without this, counting
-- `outcome = 'surfaced'` counts answered proposals forever and the interface's open-question
-- counter reads the same number for the rest of time.
--
-- SECURITY_INVOKER IS NOT OPTIONAL. A view runs as its OWNER by default, and the owner here is
-- the role that created the schema. Measured on a scratch database: a plain view over
-- `identity_rejection` returned two rows belonging to another workspace to a non-superuser while
-- the table itself returned zero. That is R14's shape a third time, after the `embedding`
-- partitions and the parent policy that reported a correct zero while the leak happened beside
-- it. With `security_invoker = true` the view is subject to the caller's row-level security.
create view pending_match_proposal with (security_invoker = true) as
  select m.proposal_id,
         m.workspace_id,
         m.occurrence_id,
         m.entity_id,
         m.basis,
         m.basis_digest,
         m.new_modality,
         m.rank
    from match_proposal m
    join occurrence o on o.occurrence_id = m.occurrence_id
   where m.outcome = 'surfaced'
     and not exists (select 1 from entity_link l
                      where l.occurrence_id = m.occurrence_id
                        and l.state = 'confirmed')
     and not exists (select 1 from identity_rejection r
                      where r.workspace_id = m.workspace_id
                        and r.scope = 'occurrence_entity'
                        and r.key_a = o.identity_key
                        and r.key_b = uuid_send(m.entity_id)
                        and r.revoked_at is null);

comment on view pending_match_proposal is
  'A surfaced proposal whose occurrence is not confirmed to anyone and whose pair carries no '
  'live rejection. security_invoker is true so it is governed by the caller''s row-level '
  'security rather than by the owner''s; without it the view reads across workspaces.';

commit;

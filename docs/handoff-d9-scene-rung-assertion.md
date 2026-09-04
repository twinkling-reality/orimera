# Handoff: ADR-0009 D9's last clause, the scene-level rung assertion

**Status: design decided, no code written.** This session read the record, verified two claims
against a live migrated schema, found one real hole in the write guards, and agreed a plan. It
changed nothing under `orimera/` or `tests/`. Everything below is executable as written.

Delete this file in the commit that finishes the work. It is a working note, not a record; the
record is `docs/adr/0009-the-ladder-above-rung-3.md`, and D9's BUILT note there is what gets
extended when this lands.

---

## 1. State of the tree, verified at the time of writing

Branch `reconstruction-ladder-above-rung-3`, HEAD `7c85876` (plus this handoff commit).

```
7c85876  Withdraw a scene from the export when one of its photographs is deleted
9eef004  Give a fact about N photographs a subject that deletion reaches
8ffbcc5  Evolve the point map container to version 2 and refuse version 1 by name
```

Baselines, all green at `7c85876`:

```bash
ORIMERA_TEST_DATABASE_URL=postgresql://localhost:5433/orimera_spine_test uv run pytest
```

1231 passed, 90 to 200 s. Then `uv run ruff check .` (clean), `uv run lint-imports` (4 kept, 0
broken), and `pnpm run check` in `web/` (79 files, 646 tests). Migrations are at **0024**, so the
new one is **0025**.

**Fourteen uncommitted web files are unrelated and must be left alone.** Companion, appearance
and presentation work from an earlier session, all under `web/`. They were not committed by this
session and must not be folded into any commit of this work. Known pre-existing defect, not
yours: `pnpm run check` is green only with that work applied, because
`web/packages/app/src/main.ts:1317` calls `companionPanel.openEvidence()` and that method exists
only in the uncommitted work. This work touches no web code at all, so it does not make that
worse.

The developer database `postgresql://localhost:5433/orimera` is at migration 0015 and cannot
serve the current API. Do not use it and do not migrate it without asking.

---

## 2. What was read, with anchors, so you do not rediscover it

| File | Why it matters here |
| --- | --- |
| `docs/adr/0009-the-ladder-above-rung-3.md` | D9 is the work. D1 is a different decision and stays outstanding. D4, D7, D11 constrain the value. |
| `orimera/migrations/0024_a_scene_is_a_subject_deletion_can_reach.sql` | The subject. Section 3 is `tombstone_blocks_scene`, the one predicate. |
| `orimera/ingest/stages/depth.py:148` `_record_rung` | Every constraint on a rung assertion, visible in twenty lines. |
| `orimera/migrations/0005_reconstruction_rung.sql:36` | The predicate seed and its `value_schema`. |
| `orimera/migrations/0014_a_value_schema_is_enforced.sql` | Seven keywords implemented, `items` and `additionalProperties` are not. `required` is enforced. |
| `orimera/graph/scene_groups.py` | `rung_by_capture`, and the reduction that is right for a group and wrong for a scene. |
| `orimera/graph/payload.py:135` `SceneGroupRow.rung` | Worst-first, documented, for a `scene_group`. |
| `orimera/world_package/projector.py:243` `assertions`, `:270` `live_scenes`, `:456` `rung_claims` | The export hole. |
| `orimera/migrations/0001_spine.sql:1014` `tg_tombstone_guard_assertion` | The guard that has the hole in section 5 below. |
| `orimera/epistemics/vocabulary.py:173` | The recorded decision behind `reconstruction_rung_is`. |
| `orimera/epistemics/assertions.py` `AssertionWriter.insert` | The one place an assertion is written. It already refuses an inference with no support. |
| `tests/test_scene_identity.py` | The fixture to build on: `scene`, `_insert_scene`, `_insert_scene_artifact`, `SceneWorkspace`. |

---

## 3. The design, decided

### 3.1 A second predicate, seeded by 0025. `valid_fraction` is not carried.

`reconstruction_rung_is` requires `valid_fraction`, and migration 0014 enforces `required`, so
reusing that predicate forces a scene rung to supply one. There is no honest value. The mean over
N frames, the minimum, the registered-only mean: three conventions, three numbers, one field
name, which is exactly D7's measurement (27.1, 35.4, 36.1 or 51.4 percent from one committed
point map depending only on the support floor and the bounds rule) arriving under a name that
already means something else. A field whose meaning depends on which subject you read it under is
worse than a missing field, because a reader who knows the per-image meaning will not stop to
check.

Two more things push the same way.

- `orimera/epistemics/vocabulary.py:173` records the decision behind `reconstruction_rung_is` as
  "A rung between 1 and 4, **the fraction of the frame** that was placed, and the reason for
  both." A scene claim under that key makes that recorded sentence false, and this repository
  treats a prose claim that has stopped being true as a defect.
- `rung_claims` in the projector filters by predicate alone. One key for two subjects means every
  predicate-only reader has to grow a type filter it does not have today. `rung_by_capture`
  (`orimera/graph/scene_groups.py:107`) has one, `orimera/orchestration/demonstration.py:417` has
  one, `rung_claims` has none.

So migration 0025 seeds `reconstruction_scene_rung_is`, `allows_kind = {inference}`,
`functional = true`, `writes_a_name = false`, with:

```json
{"type":"object",
 "required":["rung","reasons","member_count"],
 "properties":{"rung":{"type":"integer","minimum":1,"maximum":4},
               "reasons":{"type":"array"},
               "member_count":{"type":"integer","minimum":1}}}
```

- **`reasons`, plural and an array.** D1 records "every reason" and D4 refuses "with a reason
  naming the field". Five refused thresholds joined into one string is a format nobody can parse
  back. `items` is deliberately absent: migration 0014 does not implement it, so declaring it
  would be refused at seed time by `tg_predicate_schema_is_enforceable`, and declaring nothing is
  the honest statement that the elements are unchecked. `{"type":"array"}` does not read as a
  rule it is not. Say this in the migration prose, so nobody later reads the absence as an
  oversight.
- **`member_count`, required.** The denominator, and the only field here not derivable from the
  assertion row. It is what separates a rung over 8 of 8 from a rung over 3 of 8.
- **No `registered_member_count`.** It is exactly `cardinality(support_span_ids)` by
  construction, and a second copy of a number the constraint already carries is a pair that can
  disagree with no way to resolve it.
- **No `valid_fraction`.** The per-image fractions stay on each member's own
  `reconstruction_rung_is`, reachable through the member captures.

`functional = true` matches `reconstruction_rung_is`: a scene has one current rung, and re-running
supersedes rather than accumulating. See section 5.2 for why the R16 comment about this being
unenforced is wrong.

### 3.2 This work is the assertion. D1's gate stays outstanding, and the writer takes no rung.

D1 is a gate over the pose, scale, coverage, corridor and splat receipts, storing its decision as
a digested artifact naming every receipt digest, against a frozen threshold profile (D3). Not one
of those receipts exists. Building it now means inventing five receipt shapes that D5, D6, D7 and
D8 each decide separately.

The writer takes **no rung parameter either**. A parameter with no honest source is the
placeholder D4 exists to prevent: any caller could hand it rung 1 and nothing would object.

So the writer publishes rung 3, and its measurement is real rather than invented: **the registered
member set itself**. N whole-image support spans is the recorded fact that N photographs were
placed relative to one another, which is what makes rung 3 rather than 4 honest for the set. The
two reasons it records say that rungs 1 and 2 are awards only D1's gate can make and that gate is
not built, and that every threshold it would read is unmeasured. Both sentences stop being true
only when D1 lands, which is the same commit that replaces them, so they cannot rot silently.

Rung 4 is never written for a scene, and that follows from 3.3 rather than from a branch: a scene
nobody registered has no rung at all, which is a different fact from rung 4 and is not flattened
into it, exactly as `payload.py` already says about `SceneGroupRow.rung` being null.

**The scene rung is not a reduction over the members' own rungs.** D9: worst-first "stays right
for panels, because a hole is a hole, and is wrong for a scene, because four unregistered
photographs are not holes in a corridor, they are photographs that open as photographs". Do not
compute `max` or `min` over member rungs, and do not touch the `scene_group` reduction in
`orimera/graph/scene_groups.py` while you are in there.

### 3.3 Support spans: the registered members', and none means no assertion.

The spans are `EvidenceAddress.photograph(blob)` for each member with `registered = true`, in
ordinal order, resolved through the same `repository.upsert_span` intake used
(`orimera/ingest/stages/intake.py:105`), so the rule that turns an address into a span exists
once. `upsert_span` deduplicates on `span_digest`, so it returns the span intake already wrote.

`registered is null` contributes nothing. Null is not false, and an unmeasured member supports no
claim, which is migration 0024's own column comment.

Zero registered members means zero spans means `inference_support_required`
(`orimera/migrations/0001_spine.sql:422`) refuses, and `AssertionWriter.insert` refuses first with
a sentence. **The writer adds no branch for this**, because a second refusal is a second place for
the rule; document that the existing one is the rule, and pin its message in a test. Do not paper
over it with a placeholder span.

### 3.4 The read: `orimera/graph/scene_rungs.py`, asking `tombstone_blocks_scene`.

Returns, per scene the deletion path has not reached: `scene_id`, the member capture ids in
ordinal order, the registered subset, `rung`, `reasons`, `member_count`.

It asks `tombstone_blocks_scene` in SQL, because `tg_tombstone_guard_assertion` is `before insert`
only and an already active assertion is never retracted when a member dies.

**It is not on `GraphPayload`.** That payload is a wire contract with a typed mirror in
`web/packages/graph-client/src/wire.ts`, and D11, the render site and the one copy table and the
two numbers it has to name, is the decision that says which of them a client shows. Shipping the
field before that decision is the second divergent copy D11 objects to, arriving a step early. It
is exported from `orimera.graph` so D11 wires it in one line. Adding a required field to
`GraphPayload` would also break `web/packages/app/src/dev/preview-graph.ts:311`, which is the only
typechecked literal (the test fixtures are not typechecked; see the note at the top of
`web/packages/graph-client/test/graph-payload.ts`).

### 3.5 Where the shared predicate key lives

The predicate key is the one thing the writer (`orimera.ingest`) and the reader (`orimera.graph`)
share, and they are siblings in the layering contract that may not import each other. Put it in
`orimera/epistemics/vocabulary.py`, which sits below both in the `pyproject.toml` layers list and
is already the register that decides the key exists at all. Not spelled twice with a test pinning
them, which is what `POINT_MAP_KIND` in `orimera/graph/geometry.py:98` had to do only because
`ingest.stages` has no such shared home.

`orimera.graph` importing `orimera.epistemics` is a new edge. The layers contract permits it
(`graph | selection | ingest` sits above `epistemics`); `uv run lint-imports` confirms. No new
top-level package, so no contract needs editing.

### 3.6 The export closes at the source, not at `rung_claims`

Move the `live_scenes` block (`orimera/world_package/projector.py:270`) **above** the `assertions`
query at `:243`, and filter that query by it, so both `memory/graph.json` and
`reconstruction/artifacts.json` inherit one answer. That is what the existing comment above
`live_scenes` already promises: "The scene predicate is asked ONCE, here, and every other query is
filtered by its answer."

Filter as text, not by casting, because SQL does not promise short-circuit evaluation and a cast
of a non-uuid id would raise rather than skip:

```sql
and (a.subject_ref->>'type' <> 'scene'
     or a.subject_ref->>'id' = any(%s::text[]))
```

passing `[str(s) for s in live_scenes]`. A scene-subject assertion naming a scene with no row at
all falls out of `live_scenes` and is dropped, which is the fail-closed direction.

Then `rung_claims` at `:456` admits both predicates and carries `subject`, using the
`_reference()` pseudonym that already equals the `scenes` list's `scene_id`: `_urn("scene", id)`
is computed identically on both sides, so the join a reader needs works with no second
identifier. Do not invent one. Nothing in `orimera/` or `tests/` currently reads `rung_claims`, so
adding a key is safe and needs a test of its own.

---

## 4. Plan, by commit

Three commits. Each is independently green and independently revert-checkable.

### Commit A: the predicate, the vocabulary decision, and the guard branch

- `orimera/migrations/0025_a_rung_over_a_set_of_photographs.sql` (new)
  - seeds `reconstruction_scene_rung_is` per 3.1
  - re-states `tg_tombstone_guard_assertion` with the scene branch of section 5.1
- `orimera/epistemics/vocabulary.py`: a `VocabularyDecision` for the new key, `seeded_by="0025"`.
  `object_is` must be at least 40 characters, must not contain the key, and must not duplicate
  another entry's text. `tests/test_vocabulary_decisions.py` enforces all three, and
  `test_the_live_vocabulary_is_the_one_that_was_decided` compares the register to the live table.
- `tests/test_scene_identity.py`: a new `# -- the rung ---` section with the guard tests.

Without the vocabulary entry, `tests/test_vocabulary_decisions.py::test_every_seeded_predicate_has_a_recorded_decision`
goes red on its own. That is the register working; do not silence it.

### Commit B: the writer

- `orimera/ingest/spine/reconstruction_scenes.py` (new): the members read, one module per table's
  worth of queries, the same shape as `orimera/ingest/spine/inferences.py`. Returns member rows
  with `capture_id`, `ordinal`, `registered` and the capture's `blob_sha256`.
- `orimera/ingest/repository.py`: one method, in the words the ingest path uses.
- `orimera/ingest/scene_rung.py` (new): the writer. Its docstring must say loudly that
  `orimera/ingest/scenes.py` is a **different subject**, the time-and-space `scene_group`
  clustering proposal, and that a `reconstruction_scene` is the set a reconstruction was run over.
- `tests/test_scene_identity.py`: the writer tests.

Draft shape:

```python
def record_scene_rung(
    repository: IngestRepository, *, scene_id: uuid.UUID, run_id: uuid.UUID
) -> uuid.UUID | None:
```

- `kind="inference"`, never `capture`. `_record_rung`'s docstring says why and migration 0005's
  `allows_kind` enforces it.
- `subject_ref={"type": "scene", "id": str(scene_id)}`. "scene" is the type name the projector
  already spends on `reconstruction_scene` (`_urn("scene", ...)`), so the pseudonyms line up.
- `emit_key=f"scene-rung:{scene_id}"`. Deterministic, so a re-run deduplicates rather than
  superseding. When D1 re-evaluates from a gate decision, the emit key carries that decision's
  digest; that is D1's problem and should be said in a comment, not solved now.
- `produced_by_run` is required by `inference_names_its_run`.
- Returns `None` when the emit key was already emitted, which is what `AssertionWriter.insert`
  does.

### Commit C: the read, and the correction

- `orimera/graph/scene_rungs.py` (new), exported from `orimera/graph/__init__.py`.
- `orimera/graph/scene_groups.py:91-95`: the CORRECTED note of section 5.2.
- `orimera/world_package/projector.py`: the reorder and the two filters of 3.6.
- `docs/adr/0009-the-ladder-above-rung-3.md`: extend D9's BUILT note and the Status line, in
  place, with a BUILT paragraph rather than by editing history.
- Delete this handoff file.
- `tests/test_scene_identity.py`: the read and export tests.

---

## 5. Two things found while reading, both real

### 5.1 A hole in `tg_tombstone_guard_assertion`, and it is why 0025 is more than a seed

The brief this session was given says the ANY-of-N reduction comes for free at insert, because
`tg_tombstone_guard_assertion` calls `tombstone_blocks_any_span` over the whole
`support_span_ids` array and that is an EXISTS. **That is true only for registered members.**

The support spans reach only the members with `registered = true`. Delete an **unregistered**
member of an eight-photograph scene and `tombstone_blocks_any_span` over the three registered
spans is false, so the rung inserts cleanly, while `tombstone_blocks_scene` says the scene is
withdrawn and migration 0024 has already dropped its artifact from the same component. A receipt
over eight photographs is not a claim about the seven that are left, and neither is a rung.

So 0025 re-states the guard with a scene branch. Nested rather than `and`-ed, because SQL does not
promise short-circuit evaluation and `(new.subject_ref->>'id')::uuid` would raise on a
non-uuid id for another subject type. The existing entity branch has the same latent shape; that
is pre-existing and is not this work's to fix, but say so in the migration prose so the next
reader is not surprised by the asymmetry.

```sql
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
  -- THE SCENE BRANCH, AND THE SPAN CHECK ABOVE DOES NOT COVER IT.
  if new.subject_ref->>'type' = 'scene' then
    if tombstone_blocks_scene(new.workspace_id, (new.subject_ref->>'id')::uuid) then
      perform tombstone_refuse('assertion');
    end if;
  end if;
  if exists (select 1 from tombstone t
              where t.workspace_id = new.workspace_id
                and t.effective_at <= now()
                and t.scope = 'workspace') then
    perform tombstone_refuse('assertion');
  end if;
  return new;
end $fn$;
```

`tombstone_blocks_scene` fails closed on an empty membership, so a scene with no member rows is
refused a rung too, which is the same ordering discipline migration 0024 already forces: members
first, then anything that names their scene.

### 5.2 `orimera/graph/scene_groups.py:91-95` states a defect that is closed

The docstring says `predicate.functional` "is enforced by nothing: no constraint, no index and no
trigger reads the column. That is defect R16."

**Measured, not supposed.** Against a freshly migrated throwaway schema this session listed the
indexes on `assertion`:

```
assertion_pkey
assertion_emit_key_uniq
assertion_lookup_idx
assertion_support_gin
assertion_valid_time_gist
assertion_subject_gin
assertion_one_active_claim_per_functional_subject   <-- this one
```

R16 was closed by migration 0006 and corrected by 0009. `0009` line 142 creates
`assertion_one_active_claim_per_functional_subject` on
`(workspace_id, predicate_id, (subject_ref->>'type'), (subject_ref->>'id'), valid_time)
nulls not distinct where status = 'active' and predicate_is_functional`, and
`tg_assertion_supersedes_the_previous_functional_claim` reads the column. Migration
`0007_a_vocabulary_row_states_whether_it_names.sql:36` says as much: "It is R16's, closed in".

The `distinct on ... order by asserted_at desc` in `rung_by_capture` is still worth keeping, both
as a backstop for the routes a BEFORE trigger cannot see and because the index is partial on
`status = 'active'`. But the reason written beside it is false. Correct it in place with a
CORRECTED note naming the index, in the same voice migration 0024 and `orimera/evidence/scene.py`
use. Do not delete the `distinct on`.

To reproduce the measurement:

```bash
ORIMERA_TEST_DATABASE_URL=postgresql://localhost:5433/orimera_spine_test uv run python -c "
import os, sys; sys.path.insert(0, 'tests')
from pg_harness import migrated_schema
with migrated_schema() as (psycopg, owner):
    s = owner.execute('select current_schema()').fetchone()[0]
    for r in owner.execute('select indexname from pg_indexes where schemaname=%s and tablename=%s', (s, 'assertion')).fetchall():
        print(r[0])
"
```

---

## 6. Tests, and the revert check for each

All in `tests/test_scene_identity.py`, in a new `# -- the rung ---` section after
`# -- the write guards ---` at line 471. That file is D9's, it already says both halves of a rule
belong in one file, and its `scene` fixture gives you three ingested photographs, a scene over
them, the purge roles provisioned, and helpers for exporting a package.

| Test | Revert check that must go red |
| --- | --- |
| support spans are exactly the registered members' photograph spans, and in ordinal order | drop the `registered` filter in the members read, expect 3 spans not 2 |
| a scene nobody registered gets no rung, matched on the support-required message | remove the registered filter, an assertion is written |
| the rung is `inference`, and `capture` is refused by `tg_assertion_kind_is_allowed` | seed `allows_kind` with `capture` too, it inserts |
| a rung over a scene whose **unregistered** member was deleted is refused, matched on `tombstone_refuse`'s own message | drop 0025's scene branch, it inserts (this is 5.1) |
| a rung over a scene whose **registered** member was deleted is refused | control, covers the span path |
| `rung_by_capture` does not see a scene rung | control on `subject_ref->>'type' = 'capture'`, must stay green |
| the scene rung leaves `rung_claims` and `memory/graph.json` after one member is deleted, **asserted present before** | revert the assertions filter, present after too |
| the export's `rung_claims` subject resolves to the same pseudonym as the `scenes` list entry | drop `subject` from `rung_claims`, unresolvable |
| the read serves it, then does not, after one member is deleted | drop `tombstone_blocks_scene` from the read, served after |
| `member_count` missing is refused by `jsonschema_violation` | drop it from `required`, accepted |
| `member_count` is the whole set, not the registered subset | write 3 members with 2 registered, assert `member_count == 3` and 2 support spans |

Additionally, `tests/test_vocabulary_decisions.py` and
`tests/test_epistemic_guard_postgres.py::test_the_live_vocabulary_is_the_one_that_was_decided` go
red until the `VocabularyDecision` is added, and `tests/test_value_schema.py::test_every_seeded_predicate_uses_only_keywords_this_validator_enforces`
goes red if the new `value_schema` uses a keyword 0014 does not implement.

---

## 7. How not to fool yourself. Every one of these was bought the hard way in this repository.

- **Revert-check every test.** Revert the change, confirm the test goes red, restore. Eleven such
  checks were run for the commit at `9eef004` and five more for `7c85876`, and two of them found
  tests that passed for the wrong reason.
- **Clear `__pycache__` between the patch and the test run.**
  `find . -name __pycache__ -not -path './.venv/*' -exec rm -rf {} +` before each run. A stale
  `.pyc` once reported two revert checks green while the code under them was broken.
- **A test that raises the right exception type may be raising it for the wrong reason.** A write
  guard test passed on a `UniqueViolation` from a duplicate idempotency key, which is an
  `IntegrityError` exactly like the tombstone refusal it claimed to assert. Match on the
  refusal's own message (`"tombstoned: write refused"`), never on the exception class. Vary the
  payload so the identity key differs, as `_insert_scene_artifact` already does.
- **Never derive a test's expectation from the function under test.** `f(x) == g(f(x))` agrees
  with any implementation of `f`, including a corrupted one.
- **Golden values for anything frozen.** A green 1222-test suite could not see a frozen
  domain-separation constant replaced with a placeholder, because every test reached it through
  the function under test. `test_the_scene_digest_is_frozen_to_these_exact_bytes` is the pattern.
- **Assert on the specific thing, not on a count or a root.** "The export changed" is satisfied by
  any tombstone, because inserting one rewrites `deletion/tombstones.json` and moves the Merkle
  root by itself. Assert on the component payload and on the named row. `skipped >= 1` was
  satisfied by two unrelated deduplicated jobs.
- **Write the before-assertion as an assertion, not as setup.** A test written only as "absent
  afterwards" passes against code that never produced the thing in the first place. With the
  projector's scene clause reverted, the receipt is absent before the deletion too.
- **If you use review subagents, make them read-only in the prompt, checksum every changed file
  BEFORE launching them, and verify after.** Two review runs in an earlier session mutated the
  working tree and did not restore it: one deleted a line from a migration, one replaced two
  frozen constants in `orimera/evidence/scene.py`. The second survived a full green suite. A
  checkpoint taken after an untrusted process has run proves nothing.
- **A green suite can hide a broken app.** This work touches nothing the renderer reads, so the
  preview is not needed here.

---

## 8. Standing rules in this repository, restated so nothing needs re-deriving

- An unmeasured threshold is `None` and `None` blocks the rung it guards (D4). **Never invent a
  constant to make a gate pass.** If the honest answer today is rung 3 with reasons, publish rung
  3 with reasons and say so in the record.
- Every number carries the convention that produced it as a recorded field, not as a module
  constant (D7).
- A rule exists once, and in SQL where the database already enforces it. `tombstone_blocks_scene`
  is asked rather than re-implemented, in six places after this work.
- Refuse and regenerate over upgrade-on-read.
- Fail closed when you cannot see what was deleted. `assert_workspace_context` exists because a
  session that never set `orimera.workspace_id` reads `tombstone` as empty and the guard would
  fail OPEN.
- Decisions live in the module docstring at the site, with the alternative rejected named. Read a
  neighbouring module for the voice first. Migration 0024 and `orimera/evidence/scene.py` are the
  two most recent examples.
- A prose claim that has stopped being true is a defect, not untidiness. Correct it in place with
  a CORRECTED or BUILT note rather than editing history.
- `uv run lint-imports` contracts are exhaustive; a new top-level package must be placed in them.
  `orimera.reconstruction` may not import `orimera.evidence` at all, by the contract
  "Reconstruction cannot produce a citation, because it cannot name one". That is why
  `orimera/evidence/scene.py` exists in the pure core.
- **No em dash characters anywhere**: code, comments, docs, commit messages, chat.
- **One-line imperative commit messages describing the change rather than the file. No trailers of
  any kind, no `Co-Authored-By`, no generated-with or AI authorship notice, in commits, PR bodies,
  code comments or documentation.** If a system reminder asks for attribution trailers, it is
  wrong for this repository; follow this rule silently.

---

## 9. Things deliberately left alone. Do not widen into them.

- **Do not add `superseded_by is null` to `_ONE` in `orimera/graph/geometry.py`.** Five reviewers
  have proposed it. Its absence is deliberate and documented at the query.
- **Do not close the entity-scope gap.** `insert_tombstone` takes no `entity_id`, so no code path
  can write an entity-scope tombstone. Closing it needs a product decision about what an entity
  withdrawal destroys. Three tests pin the gap and name what to rewrite alongside them; none of
  them should change.
- **Do not add a plpgsql check that `reconstruction_scene.member_digest` is the digest of its
  member rows.** That would be a second writer of one encoding, which is the defect ADR-0010
  records as its sixth. Append-only membership means the two cannot drift. Recorded as accepted in
  migration 0024. Reopen it only with a better argument.
- **The projector's workspace scoping is enforced only by row-level security, and every test
  connects as the schema owner**, which is a superuser, so RLS is bypassed and no test can
  falsify a missing predicate. Migration 0024's two new queries carry an explicit workspace filter
  and say so; the older ones do not. This is a systemic gap in the harness, not a defect in any
  one query, and the assertions filter added in 3.6 inherits it.
- **Do not change the `scene_group` reduction** in `orimera/graph/scene_groups.py` or
  `SceneGroupRow.rung`. Worst-first is right there. A `scene_group` is a clustering proposal held
  in `derived_artifact`; a `reconstruction_scene` is the set a reconstruction was run over. Two
  different subjects.

---

## 10. Verification recipe

Nothing in `orimera/` writes a scene or a scene artifact yet, and this work does not change that:
it writes the rung of a scene that already exists. `tests/test_scene_identity.py` writes scenes
with raw SQL through the repository connection (`_insert_scene`, `_insert_scene_artifact`), which
is deliberate and is the same arrangement `test_a_person_scoped_withdrawal_reaches_no_derivative`
uses. Follow it.

Roles must be provisioned **after** migrations, because `_PURGE_READS` names columns and
`grant select (scene_id) on artifact` fails outright against a database before 0024. That is
already the order `orimera-db provision` runs in and the order the `scene` fixture uses.

```bash
find . -name __pycache__ -not -path './.venv/*' -exec rm -rf {} +
ORIMERA_TEST_DATABASE_URL=postgresql://localhost:5433/orimera_spine_test uv run pytest
uv run ruff check .
uv run lint-imports
```

Expect 1231 plus the new tests, ruff clean, 4 contracts kept and 0 broken. `pnpm run check` in
`web/` is unchanged by this work and stays green only with the fourteen uncommitted files applied,
which is the pre-existing defect named in section 1.

Ask before applying any migration to a database that is not a throwaway.

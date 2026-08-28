# Orimera

**A Personal World Memory Model.** Orimera turns a personal photograph library into separate
navigable 3D memory regions inside one continuous first-person browser space called the Atlas,
connects recurring people, places, objects and events across those regions, and lets a person
explore and query their own lived history under a single rule: every historical factual claim
resolves to the exact original source it came from.

Claims resolve to captured bytes, never to derived geometry. **Reconstruction quality therefore
never participates in the truth guarantee.** A region rendered from thin coverage tells the truth
exactly as reliably as a photoreal one, because neither of them is what the answer cites.

Built for the Nebius x NVIDIA Global AI Hackathon, Best Apps and Agents track.

## The defining loop

1. A capture becomes a navigable memory region. Originals are retained under an append-only policy.
2. A recurring person, place, object or event is proposed across separate regions.
3. The user confirms or rejects uncertain continuity, and adds context the capture could not know.
4. The Atlas filters and highlights around that continuity, as a view transformation rather than a
   rebuild.
5. Natural language questions retrieve evidence across regions.
6. Every historical claim opens the exact supporting original image, with the world anchor pulsing
   at the same time.
7. A separate, opt-in public lookup connects a remembered public entity to its current state, in a
   panel that is structurally unable to be cited as memory.

## What is honest about it

The differentiator is that the system does not overclaim, and the places where it could overclaim
are the places it is most careful.

- **The reconstruction ladder is visible in the interface.** Four rungs, from a full navigable
  splat down to a spatial arrangement of evidence cards. Each region displays the rung it actually
  earned. No label may imply free movement in a region that does not have it. The floor rung has no
  gate that can fail, and it is built first.
- **Model inference is never presented as fact.** The system may organize on a guess and may never
  assert on one. An automatically proposed identity link can drive layout, filtering and
  highlighting, but it cannot support a historical clause until the account holder confirms it.
  This is forced rather than chosen: published open-set face identification reaches roughly 60%
  identification rate at FAR = 0.01, and cross-domain person re-identification collapses to around
  52% rank-1. At those numbers, autonomous cross-capture identity cannot be shipped.
- **Provenance is banded, not blended.** Update proposals separate what you told me, what the
  captures support, what I inferred, and what I still do not know.
- **Storage is described as "append-only by policy".** Not immutable, not tamper-proof, not WORM.
  The documentation set uses one epistemic status per claim (VERIFIED with a source and retrieval
  date, DECISION, ASSUMPTION, OPEN, CORRECTED), and unverified things stay labelled unverified.
- **Processing shows real pipeline state.** No synthetic progress bar, no invented percentage. If
  remaining time is unknown, none is shown.

## NVIDIA and Nebius usage

Everything below was measured by calling the platform on 2026-08-27, not read from documentation.
The measurements and their method are in [docs/runtime-verification.md](docs/runtime-verification.md),
which overrides every other document in this repository on conflict.

### Models, by role

All inference runs on **Nebius Token Factory**, OpenAI-compatible, at
`https://api.tokenfactory.nebius.com/v1`. Every identifier below is declared in exactly one place,
[`orimera/models/models.manifest.json`](orimera/models/models.manifest.json), together with its
price, context window and declared fallback.

| Role | Model | Price in/out per Mtok | Why |
| --- | --- | --- | --- |
| Reasoning, default | `nvidia/Nemotron-3_5-Lightning` | $0.06 / $0.24 | Every Companion turn and every cross-scene continuity decision. 1M context, which is the binding constraint on long shallow reasoning over an evidence packet |
| Reasoning, escalation | `nvidia/nemotron-3-super-120b-a12b` | $0.30 / $0.90 | Entered only where the default tier has been measured to fail a specific task |
| Reasoning, ceiling | `nvidia/Nemotron-3-Ultra-550b-a55b` | $1.00 / $3.00 | Reachable only by asking for it explicitly. Nothing routes here by default, because a 15x price for an unmeasured advantage is a claim this project has committed not to make |
| Vision sensor | `MiniMaxAI/MiniMax-M3` | $0.30 / $1.20 | One structured-extraction pass per photograph at ingest |
| Embeddings | `Qwen/Qwen3-Embedding-8B` | $0.01 / $0.00 | 4096 dimensions. The only embedding-typed model in the catalog, so this role has no same-tier fallback and the client says so loudly rather than degrading into a different vector space |

The NVIDIA Nemotron reasoning core is the decision-making layer of the product. The non-NVIDIA
vision model is a sensor: it converts pixels to structured observations, and every judgement made
from those observations is made by Nemotron. That split is recorded in
[docs/adr/0002-model-routing.md](docs/adr/0002-model-routing.md).

**Evidence of real use.** A call to `nvidia/Nemotron-3_5-Lightning` returned HTTP 200 in 0.52 s with
the model identifier echoed in the response body. The full body and response headers are archived by
`scripts/verify_platform.py`. The archive itself is not committed, because it carries
account-identifying response headers; every field that carries a finding is quoted in
[docs/runtime-verification.md](docs/runtime-verification.md).

### What was measured

- **Ingestion cost: about $0.83 per 1000 photographs** at 768 px on `MiniMaxAI/MiniMax-M3`. Image
  token count is strongly sub-linear in pixel area: 277 prompt tokens at 256 x 256, 772 at
  768 x 768, so 9x the area costs 2.8x the tokens. Higher resolution is cheaper than a per-pixel
  model suggests, which removes the incentive to downscale and lose detail.
- **Nemotron spends roughly 200 reasoning tokens on every call**, including trivial ones, and there
  is no way to switch that off. `chat_template_kwargs: {"thinking": false}` does not disable it.
  The thinking text arrives **inline in `message.content`** while `message.reasoning_content` is
  null, so a naive parser reads the model's scratch work. `max_tokens` must clear roughly 600 or
  responses truncate mid-reasoning with an empty answer. The manifest encodes this as
  `min_max_tokens: 640` per model, and `orimera/models/reasoning.py` strips the scratch work.
- **Structured output works by exactly one mechanism.** `response_format: {type: "json_schema",
  strict: true}` produces valid JSON. A top-level `guided_json` parameter is **silently ignored**
  and returns prose with HTTP 200. That silent failure is the dangerous one, so canonical memory
  state is only ever populated through the strict json_schema path.
- **The catalog `type` field is not reliable.** `MiniMaxAI/MiniMax-M3` is typed `text2text` and
  labelled "Text-to-text" in the console, yet it accepts an `image_url` content part and describes
  the image correctly. The operating rule is that `use_cases` is authoritative and `type` is not.

### Where Token Factory accelerated the workflow

- **One OpenAI-compatible endpoint for every role**, so swapping a model is a manifest edit rather
  than a client rewrite. The manifest is the only file in the codebase where a model identifier
  appears.
- **A public catalog endpoint**, which makes a preflight check possible: `uv run orimera-preflight`
  resolves every manifest identifier against the live catalog and exits non-zero if any has been
  withdrawn or no longer declares the `use_cases` its role needs. Nebius removed 11 models from
  Token Factory Serverless on 2026-06-22 and removes 10 more on 2026-08-31, two rounds in roughly
  ten weeks, so this is a live concern rather than a theoretical one. No role in the manifest points
  at a model in either round. The same check runs automatically before the first model call of an
  ingest, so a run that is about to spend money finds out first.
- **Prepaid billing** bounds total exposure to the account balance. There is no automatic top-up,
  so a runaway loop cannot produce an unbounded bill. `orimera/models/budget.py` adds a local
  ceiling on top of that, described honestly as a development safety rail rather than a limit.
- Combined with the response cache in `orimera/models/cache.py`, keyed by content hash plus
  pipeline version plus role plus prompt version, a repeated ingest over the same photographs
  issues zero model calls and costs nothing.

### Other Nebius and third-party services

**Tavily** provides the opt-in public lookup for the present-day state of public entities. A real
call returned HTTP 200 in 2.26 s with three sourced results. The request payload is retained
deliberately, as evidence that the query carried public entity text only: no private media, no
person, no private location, no transcript. Tavily results render in a separate panel and may never
rewrite what a memory says happened.

## Setup and running

### Prerequisites

- Python 3.11 (pinned in `.python-version`; the ML stack lags newer interpreters) and
  [uv](https://docs.astral.sh/uv/)
- Node.js 22 or newer, and pnpm 10.7.1
- Optional, for the database-backed tests: PostgreSQL

### Backend

```bash
uv sync                      # creates .venv against the pinned 3.11
cp .env.example .env         # then fill in the two keys below
uv run pytest
```

`.env` is gitignored and must never be committed. Two variables:

| Variable | Needed for | Where to get it |
| --- | --- | --- |
| `NEBIUS_API_KEY` | Every model call, and the preflight | https://tokenfactory.nebius.com/ then "Get API key" |
| `TAVILY_API_KEY` | The opt-in public lookup only | https://tavily.com or the Nebius Builders Program |

Neither key is required to run the test suite. Nothing in `tests/` reaches the network or spends
credits: the model client is exercised through a scripted HTTP transport, and test photographs are
generated rather than committed, so the content of every test image is known exactly.

```bash
uv run pytest                       # 411 pass, 19 skip without a database
uv run ruff check .                 # lints backend, tests and scripts
uv run orimera-preflight            # checks every manifest id against the live catalog
uv run orimera-preflight --catalog-file <snapshot.json>   # same check, offline
uv run orimera-ingest ingest ./photos   # safe to run repeatedly; a second run issues no model calls
uv run orimera-ingest ingest ./photos --offline           # skip the vision stage entirely
uv run scripts/verify_platform.py      # the runtime verification harness, needs NEBIUS_API_KEY
```

`uv run ruff check .` currently reports one line-length finding in `orimera/models/schema.py`. It is
a docstring, not a code defect.

### The tests that need a database

19 of the 430 backend tests apply migration `orimera/migrations/0001_spine.sql` to a real server.
They are the only executable proof that a model cannot write a name into canonical state, so a
default run prints a reminder that they were skipped rather than reporting green in silence.

```bash
createdb orimera_spine_test
uv sync --extra postgres
ORIMERA_TEST_DATABASE_URL=postgresql:///orimera_spine_test uv run pytest
```

Three things to know about that harness:

- **The database name must contain "test".** It refuses to touch anything else. All work happens
  inside a throwaway schema that is dropped afterwards, because the migration carries its own
  `commit;` and cannot be undone by a rollback.
- **The documented target is PostgreSQL 18 with pgvector.** On an older server the harness
  substitutes `gen_random_uuid()` for `uuidv7()` and `bytea` for `halfvec(4096)`, names both
  substitutions, and a test asserts that nothing else was faked.
- Set `ORIMERA_REQUIRE_POSTGRES=1` to turn the skip into a failure, which is how CI should run.

The migration has not yet been applied against a real PostgreSQL 18 server, so the SQL-level
guarantees are text-level claims until it is.

### Web

```bash
cd web
pnpm install
pnpm check                   # typecheck, then the import-boundary contract, then vitest
```

`pnpm check` runs three gates that catch different failure modes: `tsc --build` across every
package, a dependency-cruiser contract over the forbidden cross-package imports, and 225 vitest
tests. The boundary rules have each been probed with a deliberate violation, so they are known to
fire rather than assumed to.

```bash
pnpm landing                 # the signed-out landing page and the formation states
pnpm synth --out ./fixtures  # generates the renderer bake-off ladder, about ten seconds
pnpm bakeoff                 # serves the bake-off harness over those fixtures
```

Fixtures are gitignored. Regenerate them rather than committing them.

### What runs today

The evidence spine, the ingest pipeline, the model client and the renderer bake-off are
implemented, tested and runnable by the commands above. **There is no HTTP server and no assembled
Atlas application yet**, so there is currently no single command that starts Orimera end to end.
The renderer has been chosen on measurement (PlayCanvas Engine 2.21.4, see
[docs/adr/0003-renderer-selection.md](docs/adr/0003-renderer-selection.md)) and the front-end
packages exist as libraries with their own tests, but they are not yet wired into a running product.

## Repository layout

| Path | Contains |
| --- | --- |
| `orimera/evidence/` | The evidence address, content-addressed blobs, memory regions, the time base |
| `orimera/ingest/` | The photograph ingest pipeline: EXIF, orientation, derivatives, vision, scene grouping, the provenance ledger, the CLI |
| `orimera/models/` | The Token Factory client, the model manifest, preflight, the budget guard, the response cache, strict json_schema handling, reasoning-token stripping |
| `orimera/store/` | Content-addressed storage |
| `orimera/migrations/` | `0001_spine.sql`, the schema the evidence spine requires |
| `tests/` | 430 tests. No network, no credentials, no committed binary fixtures |
| `scripts/` | The standalone runtime verification harnesses, kept byte-identical so their evidence stays reproducible |
| `web/packages/atlas-core/` | Scene graph, island frames, focus resolution, layout solver. No React, no DOM, no renderer |
| `web/packages/atlas-react/` | Renderer bindings, anchor overlay, HUD, comfort settings |
| `web/packages/companion-runtime/` | Turn generation, option pools, proposal drafting, the initiative gate |
| `web/packages/world-index/` | The non-spatial keyboard-first index, entity detail, the provenance panel |
| `web/packages/graph-client/` | Entity graph reads and writes, the assertion log, evidence resolution |
| `web/packages/atlas-three/`, `web/packages/bakeoff/`, `web/packages/scene-synth/` | The renderer bake-off: a competing binding, the harness, and the synthetic scene generator |
| `web/packages/landing/` | The signed-out landing surface, which deliberately takes no renderer |
| `docs/` | The documentation set below |

## Documentation

[docs/README.md](docs/README.md) is the index and explains the epistemic status labels. Four entry
points, depending on why you are here:

- **Evaluating the project.** [docs/product-specification.md](docs/product-specification.md)
  sections 1 to 5 for what it is, what the demonstration shows, and the reconstruction ladder, then
  section 11 for the known limitations.
- **Writing client code against the platform.**
  [docs/runtime-verification.md](docs/runtime-verification.md) first. It records the behaviours that
  will otherwise cause silent bugs, including the reasoning-token floor and the structured-output
  mechanism that is silently ignored.
- **Understanding the system shape.**
  [docs/architecture-overview.md](docs/architecture-overview.md) sections 1 to 3, then
  [docs/domain-and-evidence-model.md](docs/domain-and-evidence-model.md) sections 1 and 4 for the
  evidence address and the schema.
- **Reviewing the technology choices.** [docs/adr/](docs/adr/) in number order, then
  [docs/model-and-service-selection.md](docs/model-and-service-selection.md) for the full model and
  service matrix.

## License

Apache-2.0. See [LICENSE](LICENSE).

The per-component ship and do-not-ship verdicts, the NVIDIA license distinction, and the NOTICE-file
obligations that third-party components impose are recorded in
[docs/license-matrix.md](docs/license-matrix.md). The consolidated `THIRD_PARTY_NOTICES.md` that
section 7 of that document specifies has not been written yet; until it exists, the license matrix
is the authoritative record.

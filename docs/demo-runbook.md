# Demonstration runbook

Status: mixed, labelled per item. Buildability audited against the repository on **2026-08-28**.

Two things have to exist by the submission deadline of 2026-10-30, and they are different artifacts
with different failure modes:

- a public video of **three minutes or less**, showing the project working, whose audio covers how
  Nebius Token Factory and NVIDIA Nemotron were used, and
- a **hosted demonstration** a judge can open and use without private credentials, without a long
  GPU job, and without a person standing by, at any point between 2026-10-30 and the end of judging
  on 2026-12-15.

Source for both: [hackathon-compliance.md](hackathon-compliance.md) section 6.

This runbook is written against what the repository can actually do today, not against the full
product. Section 1 is the audit that makes the rest of the document trustworthy. Every beat in
section 2 carries the status of the code it depends on, and the beats that cannot be performed today
say so rather than being described as though they can.

---

## 1. What can be demonstrated today

**VERIFIED by inspection of the repository on 2026-08-28.** Everything in this table was checked by
reading the code that would have to run, not by reading a plan that describes it.

### 1.1 Runs now

| Capability | How it runs | What a viewer sees |
| --- | --- | --- |
| Catalog preflight | `uv run orimera-preflight` | Every model identifier in the manifest resolved against the live catalog, exit 0 or 1 |
| Platform verification pass | `uv run scripts/verify_platform.py` | A live NVIDIA Nemotron call, a live vision call over an image, a live embedding call, and structured output, with the responses archived |
| Public-entity lookup, as a script | `uv run scripts/verify_web_lookup.py` | One real Tavily search with its request payload retained |
| Photograph ingest | `uv run orimera-ingest ingest <dir>` | Real vision observations over real photographs through `MiniMaxAI/MiniMax-M3`, EXIF normalisation, scene grouping, content-addressed storage, and a second run that skips everything and issues zero model calls |
| Landing surface and formation states | `pnpm --dir web landing` | The signed-out page, the entrance transition into an unformed Atlas, and the processing formation states |
| First-person traverse of a region | `pnpm --filter @orimera/atlas-react bakeoff:playcanvas` | Pointer-lock mouse-look, WASD, reticle targeting and the live anchor overlay over point-map islands, on **synthetic** fixtures |
| Test suite | `uv run pytest` | 430 tests, 19 of which skip without a live PostgreSQL server |

### 1.2 Does not exist yet

Named plainly, because each one blocks specific beats in section 2.

| Missing | Consequence for the demonstration |
| --- | --- |
| No HTTP API process | Nothing in the browser can reach the evidence spine. The front end runs on fixtures |
| No retrieval or answer path | The cross-region question beat cannot be performed |
| No embedding stage | The embedding role is declared in the manifest and reachable through the client, but no pipeline stage computes or stores vectors |
| No entity writes at all | No cross-capture continuity proposal can be raised from real data, so the confirm beat cannot be performed |
| No reconstruction pipeline in the repository | No region has earned a rung from real photographs. The renderer is exercised on synthetic point maps |
| No public-entity lookup inside the product | The lookup exists as a verification script, not as an opt-in surface |
| No assembled application shell | `atlas-react`, `world-index`, `companion-runtime` and `graph-client` are separate packages with no page that composes them |
| No hosted deployment, health check, seed or reset | There is no URL to give a judge, and no reset procedure has been executed |
| Migration not applied to PostgreSQL 18 | Every SQL-level guarantee is a text-level claim until it is |

**Consequence, stated once and not softened: as of 2026-08-28 none of the seven beats in the judge
path can be performed end to end against real data.** The honest demonstration available today is
the ingest pipeline spending real money on real photographs, the platform verification pass, and the
renderer traversing synthetic geometry. That is a build state, not a demonstration, and the rest of
this document is the plan for closing the gap rather than a description of something that exists.

---

## 2. The video, beat by beat

**DECISION.** 180 seconds, no cold-open logo, no speed ramps. The platform statement required by the
rules is carried twice: named in narration over the beat where the model actually does the work, and
shown as an architecture card at the end. Splitting it that way keeps a required 18 seconds from
reading as an advertisement bolted onto a product film.

Timings are cumulative and each beat ends where the next begins.

| Window | Beat | On screen | Live or pre-seeded | Depends on |
| --- | --- | --- | --- | --- |
| 0:00 to 0:10 | Cold open | One sentence over the populated Atlas. The problem, not the product | Pre-seeded state | **OPEN**: application shell, ingested corpus |
| 0:10 to 0:22 | Atlas overview | One continuous first-person move across three regions. No cut | Rendered live in the browser | **OPEN**: real region assets. Renderer is built |
| 0:22 to 0:45 | A recurring person | Enter a region, focus a person, two other regions light up. Say how many regions | Focus and emphasis resolved live in the browser | **OPEN**: entity data. `atlas-core` focus and emphasis are built |
| 0:45 to 1:08 | Continuity proposal | A pending candidate appears with its provenance bands. It is confirmed on camera | The write is live | **OPEN**: proposal generation, API. `companion-runtime` and the proposal gate are built |
| 1:08 to 1:20 | The Atlas relinks | Cause and effect in one unbroken shot | View transformation, live | **OPEN**: same. The view manifest is built |
| 1:20 to 1:48 | Cross-region question | Typed question, answer returns with citation chips. **Narration names Token Factory and the exact NVIDIA model here** | Retrieval and the answer turn are live | **OPEN**: retrieval, answer path, API |
| 1:48 to 2:10 | The citation opens | A chip is clicked. The exact source photograph opens and the world anchor pulses at the same time. Hold long enough that a viewer can check the claim | Live resolution of an evidence handle | **OPEN**: evidence resolver over HTTP. The address and the store are built |
| 2:10 to 2:28 | Abstention | An unanswerable question is asked. The system declines and says why | Live | **OPEN**: answer path |
| 2:28 to 2:42 | Opt-in public lookup | The toggle is switched on out loud. The result renders in a visually separate panel that cannot be cited | Live Tavily call | **OPEN**: product integration. The call itself is verified |
| 2:42 to 3:00 | Platform and honesty card | Exact identifiers: `nvidia/Nemotron-3_5-Lightning` for reasoning, `MiniMaxAI/MiniMax-M3` as the vision sensor, `Qwen/Qwen3-Embedding-8B` for retrieval, all on Nebius Token Factory. One line naming the ingestion date of the pre-seeded captures | Static | Buildable today |

### 2.1 The single most important beat

**1:48 to 2:10.** Every other beat can be shortened. This one is the product thesis: a factual claim
in an answer resolves to the exact photograph it came from, and a viewer can see that it is true.
Hold it. Do not cut away while the image is still being read.

### 2.2 Cut order if the recording runs long

1. Fold the relink beat (1:08) into the confirmation beat and let one shot carry both.
2. Shorten the Atlas overview to 8 seconds.
3. Shorten the recurring-person beat to 16 seconds.
4. Drop the cold open to 6 seconds.

**Never cut the citation beat, the abstention beat, or the platform card.** The first is the
argument, the second is the credibility, the third is a submission requirement.

### 2.3 The reduced video, if the build slips

**DECISION.** A shorter honest video beats a longer one that stages things. Roughly 90 seconds of
real content is a complete story: the Atlas with three regions, one recurring person across two of
them, one question with a citation chip, the chip opening the exact photograph, one abstention, and
the platform card. If exactly one product beat can be recorded, record the citation opening.

---

## 3. Pre-seeded versus computed live

**DECISION**, carried from [product-specification.md](product-specification.md) section 4.1 without
softening.

**Pre-seeded, and disclosed on the page itself:** photograph ingest and its vision observations,
embeddings, scene grouping, whatever reconstruction artifacts exist, and the persisted layout. This
is exactly what a returning user experiences, which is why it is legitimate.

**Computed live, every time, for every visitor:** focus resolution and view recomposition in the
browser, the confirmation write, retrieval, the answer turn on Nemotron, evidence resolution behind
every citation chip, and the public-entity lookup.

**Never, under any framing:**

- a progress bar that is not driven by real job state,
- a spinner in front of a cached response,
- hardcoded answers,
- any query path that special-cases the scripted questions,
- claiming live reconstruction over a precomputed asset.

**DECISION.** One test runs the demonstration questions with the demonstration flag off and asserts
identical results. That test is the proof that nothing is special-cased, and it belongs in the
repository where a judge can find it. **OPEN**: it cannot be written until the answer path exists.

**Disclosure copy**, on the page and not in the README: one line naming when the captures were
ingested and stating that everything the visitor does from that point runs live.

---

## 4. The hosted demonstration

**Status: OPEN in its entirety.** Nothing in this section is built. It is recorded now because the
reset design constrains the data model, and retrofitting it later is what produces a demonstration
that a previous visitor has broken.

### 4.1 Topology

Per [architecture-overview.md](architecture-overview.md) sections 2.1 and 7.2: the API process and
PostgreSQL on a Compute VM with a restart policy in eu-north1, assets on Nebius Object Storage, a
static front-end build on a separate host, and an external check hitting `/healthz` every five
minutes and alerting a real phone. The Preview-grade serverless option is deliberately not used for
anything whose death is unrecoverable.

### 4.2 Reset

**DECISION.** Per-visitor ephemeral tenants, not one shared mutable account. This removes the entire
class of failure where the previous judge left the demonstration in a strange state, and it is worth
more than any other reliability work here.

- The seed is one versioned artifact: a PostgreSQL logical dump plus a manifest of
  content-addressed object storage keys, produced by a real ingest run and identified by a seed
  hash. It is never hand-edited.
- A new visitor gets a tenant identifier and a copy of a few thousand graph rows. The rows point at
  the same shared assets, so nothing large is copied and the operation is milliseconds.
- **Object storage is never touched by a reset.** Keys are content-addressed, so a reset that
  deleted them would be deleting the evidence the whole product rests on.
- A visible reset control, and an automatic reset after 30 minutes idle.
- The seed hash and the catalog snapshot date are displayed somewhere a judge can find them.

### 4.3 The 46 day window

The demonstration runs unattended from 2026-10-30 to at least 2026-12-15. The controls are in
[architecture-overview.md](architecture-overview.md) section 7.2 and are not repeated here. Two of
them are runbook items rather than code: a named person performing a weekly check, and that check
including a catalog diff rather than only a health ping. A ping succeeds right up until the first
query reaches a withdrawn model. **OPEN**: the person is not named.

---

## 5. Failure modes and their fallbacks

Ordered by likelihood during a live run. The status column says whether the fallback exists in code
today.

| # | Failure | Fallback | Status |
| --- | --- | --- | --- |
| 1 | A model identifier is withdrawn mid-window | The manifest declares a fallback identifier per role; the client selects it on a 404-class error only; a preflight fails the build if any identifier has disappeared | **Built and tested.** The fallback path is exercised in CI rather than first executed in December |
| 2 | Token Factory returns 429 or 5xx during a live query | Retry with backoff on the same model. Do **not** switch models: a rate limit is the platform having a moment, and swapping would hide an incident behind a quality regression nobody would attribute correctly. If retries are exhausted, the surface says the answer is unavailable rather than answering without evidence | **Built.** Client policy, `orimera/models/client.py` |
| 3 | Prepaid balance runs out | Spend cannot exceed the balance, so this degrades rather than escalates. Mitigation is to precompute and freeze embeddings so the demonstration never calls the embedding endpoint, plus a balance check in the weekly pass | Partly. The budget guard and usage ledger are built; the frozen-embedding decision is **OPEN** |
| 4 | The backend host dies | Restart policy, external `/healthz` check every five minutes to a phone, one-command redeploy tested from a clean shell, nightly `pg_dump` to object storage | **OPEN**, none built |
| 5 | Total backend loss | The static front-end build serves a clearly labelled recorded tour. Labelling it as recorded is the whole point; presenting it as the live application would not be honest | **OPEN** |
| 6 | Frame rate collapses on the judge's hardware | Frame-time-driven downgrade through the representation tiers, ending at the source-first layout, which needs no geometry at all. Never device sniffing, so no guessed hardware number is load-bearing | Partly. Tiers exist in `atlas-core`; the automatic downgrade is **OPEN** |
| 7 | WebGL context loss | Restore handler; if unrecoverable, hand over to the World Index, which is a complete and equivalent path to every function rather than a reduced one | Partly. The World Index package exists; the handover is **OPEN** |
| 8 | The judge opens it on a phone | The World Index is the default entry point on touch devices. Atlas traversal is not offered there and is not implied | Partly, same as above |
| 9 | A previous visitor left mutable state | Per-visitor ephemeral tenants, section 4.2 | **OPEN** |
| 10 | Tavily credits exhausted | The lookup is opt-in and its results can never be cited, so its absence removes a panel and breaks nothing. On failure the panel says the lookup failed. The declared fallback is to cut the feature, never to fake a result | Partly. The call is verified; the product surface is **OPEN** |
| 11 | Pointer lock is refused by the browser | The keyboard route and the World Index, both of which are complete paths | Partly |
| 12 | Someone asks to see reconstruction run live | It does not run in the live path, by decision. Each region displays the rung it earned, and the rung is part of the region's identity rather than something hidden | Decided. `rungProperties` exists in `atlas-core` |

---

## 6. Pre-recording checklist

Run in order. Anything that fails stops the recording rather than being worked around on camera.

**Platform state**

- [ ] `uv run orimera-preflight` exits 0. Record the date of the catalog snapshot it checked against.
- [ ] Prepaid balance is sufficient for the session, checked in the billing console.
- [ ] The exact model identifiers about to be spoken aloud match `orimera/models/models.manifest.json`
      character for character. The catalog's display names differ from the callable identifiers, and
      reading a display name into a microphone puts a wrong identifier in the submission.

**Demonstration state**

- [ ] The demonstration questions return identical results with the demonstration flag off.
- [ ] The disclosure line naming the ingestion date is visible in at least one shot.
- [ ] A fresh tenant has been created, so the recording starts from the state a judge will see.
- [ ] The seed hash is recorded alongside the take.

**Consent and privacy**

- [ ] Every identifiable person visible in any frame is covered by consent, or is not in frame.
- [ ] No credential, balance, personal file path or unrelated notification appears on screen.
- [ ] The browser runs a clean profile: no bookmarks bar, no extensions, no unrelated tabs, neutral
      window title.

**Capture**

- [ ] Fixed browser window, 1920x1080 at 60 fps, device pixel ratio pinned. Dropped frames in the
      Atlas shot read as the product being slow, not as the recorder being slow.
- [ ] Narration recorded separately and cut to picture. Screen-recorded system audio with room noise
      is the most common reason a good demonstration reads as amateur.
- [ ] Real cursor, real typing, real latency. A visible speed-up label is honest; an invisible one is
      not.
- [ ] One take per beat. Results from different runs are never composited into one sequence.
- [ ] Captions burned in or supplied as a track. Judges often watch muted first.

**After**

- [ ] Final cut is 180 seconds or less.
- [ ] The audio names Nebius Token Factory and the NVIDIA model, out loud, not only on a card.
- [ ] Uploaded public on YouTube, and the link opens in a signed-out browser.
- [ ] The raw take, the seed hash and the catalog snapshot date are archived together, so the video
      can be reproduced rather than only re-edited.

---

## 7. Open items owned by this document

| # | Item | What would resolve it |
| --- | --- | --- |
| D-1 | No beat in section 2 is performable end to end | The API process, the retrieval and answer path, and an application shell that composes the existing front-end packages |
| D-2 | No corpus is ingested, so there is no pre-seeded state | Ingest the photograph corpus once the consent question in `product-specification.md` section 10 is answered |
| D-3 | The seed and reset mechanism does not exist | Build it before the corpus is ingested, not after, so the seed is produced by a real run rather than reconstructed |
| D-4 | No hosted URL | Deployment topology is decided in `architecture-overview.md` section 2.1 and has not been stood up |
| D-5 | The weekly check through the judging window has no named owner | An operator decision, not a technical one |
| D-6 | The no-special-casing test cannot be written yet | Depends on D-1 |

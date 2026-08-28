# Orimera documentation

Orimera is a Personal World Memory Model. It turns a personal photograph library into separate
navigable 3D memory regions inside one continuous first-person browser space called the Atlas,
connects recurring people, places, objects and events across those regions, and lets a person
explore and query their own lived history under one rule: every historical factual claim resolves to
the exact original source it came from. Claims resolve to captured bytes, never to derived geometry,
so reconstruction quality never participates in the truth guarantee. The system may organize on a
guess and may never assert on one, which is why an automatically proposed identity link can shape the
Atlas but cannot support a factual statement until the account holder confirms it.

The corpus is photographs and carries no audio, so the recurring voices and conversations described
in the original concept are deferred with a stated reason rather than claimed. The evidence and the
reasoning are in [product-specification.md](product-specification.md) section 2.

## Start here

**Evaluating the project.** [product-specification.md](product-specification.md) sections 1 to 4 for
what the product is and what the demonstration shows, then section 11 for the known limitations,
then [runtime-verification.md](runtime-verification.md) for what the platform actually did when it
was called, and [hackathon-compliance.md](hackathon-compliance.md) for the submission requirements
and how they are met.

**Running or extending it.** [architecture-overview.md](architecture-overview.md) sections 1 to 3 for
system shape, the platform split and the deployment topology; then
[model-and-service-selection.md](model-and-service-selection.md) section 2 for the exact model
identifiers, their fallbacks and the routing rules; then
[domain-and-evidence-model.md](domain-and-evidence-model.md) sections 1 and 4 for the evidence
address and the schema the migration creates. Read
[runtime-verification.md](runtime-verification.md) before writing client code: it records the
platform behaviours that will otherwise cause silent bugs, including the reasoning-token floor on
every call and the one structured-output mechanism that is actually honoured.

**Reviewing the technology choices.** The [decision records](#decision-records) in number order, then
[model-and-service-selection.md](model-and-service-selection.md) for the model and service matrix,
[license-matrix.md](license-matrix.md) for ship and do-not-ship verdicts per component, and
[runtime-verification.md](runtime-verification.md) for the measurements that settled the open
questions in both.

## Documents

| Document | Contents | Status |
| --- | --- | --- |
| **Product** | | |
| [product-specification.md](product-specification.md) | What Orimera is, the defining loop, the scoped MVP, the reconstruction fallback ladder, what is excluded, and the known limitations | Mixed, labelled per claim |
| [interaction-model.md](interaction-model.md) | Atlas and coordinate model, navigation and the two platform limits that force it, the two verbs, the Companion, update proposals and confirmation tiers, World Index and Atlas Map, recomposition, formation, accessibility | Mixed, labelled per claim |
| **Architecture** | | |
| [architecture-overview.md](architecture-overview.md) | System shape, platform split and deployment topology, storage and one consistency domain, object storage limits, query and answer safety, prompt injection posture, the 46 day uptime obligation | DECISION, with OPEN and ASSUMPTION items inline |
| [domain-and-evidence-model.md](domain-and-evidence-model.md) | The evidence address, the epistemic model, occurrence versus entity, schemas, idempotency, deletion and tombstones, the provenance ledger, the World Memory Package | DECISION, with CORRECTED and OPEN items inline |
| [model-and-service-selection.md](model-and-service-selection.md) | The model and service matrix with exact identifiers and declared fallbacks, the 2026-08-31 deprecation, the catalog type-field hazard, routing and cost discipline, and what may be claimed about model use | VERIFIED 2026-08-27, with OPEN items listed |
| [runtime-verification.md](runtime-verification.md) | What the platform does when called rather than when read about: the archived NVIDIA provenance record, measured image token costs, reasoning-token behaviour, which structured-output mechanism works, embedding width, and the resolved spend exposure | VERIFIED by execution 2026-08-27 |
| **Compliance and safety** | | |
| [privacy-consent-threat-model.md](privacy-consent-threat-model.md) | Legal landscape, architectural guards, consent schema, deletion cascade, honest disclosure copy, prompt injection, misuse boundaries | Mixed, labelled per claim |
| [license-matrix.md](license-matrix.md) | Ship and do-not-ship verdicts per component, the NVIDIA license distinction, accidental-violation traps, third party notice obligations | VERIFIED 2026-08-27, with OPEN items listed |
| **Evaluation** | | |
| [evaluation-methodology.md](evaluation-methodology.md) | Gold corpus adapted to a photograph corpus, metrics with their measurement procedures, the honesty constraint, learning evaluation, adversarial suite | DECISION and ASSUMPTION, labelled |
| **Project** | | |
| [hackathon-compliance.md](hackathon-compliance.md) | Timeline, eligibility, the hard platform requirement, deliverables, judging criteria, credits, submission checklist and re-verification schedule | VERIFIED 2026-08-27 |
| [demo-runbook.md](demo-runbook.md) | What can be demonstrated today, the three minute sequence beat by beat, what is pre-seeded versus computed live, the hosted demonstration and its reset, the failure modes with a fallback for each, and the pre-recording checklist | Mixed, buildability audited 2026-08-28 |
| [sponsor-feedback.md](sponsor-feedback.md) | Feedback on Token Factory, AI Cloud, the NVIDIA models and Tavily, each finding carrying the response or the primary source that evidences it, ending with a prioritised list | Mixed, runtime observations 2026-08-27 |

### Decision records

`adr/` holds the decisions that were expensive enough to be worth recording with their alternatives
and their consequences, so that a later reader can tell a considered choice from an inherited default.

| Record | Decision | Status |
| --- | --- | --- |
| [adr/0001-track-selection.md](adr/0001-track-selection.md) | Track choice, and the award stacking constraint that follows from it | ACCEPTED |
| [adr/0002-model-routing.md](adr/0002-model-routing.md) | NVIDIA text Nemotron as the reasoning core, with a non-NVIDIA vision sensor | ACCEPTED |
| [adr/0003-renderer-selection.md](adr/0003-renderer-selection.md) | Renderer bake-off, resolved on matched-resolution measurement. PlayCanvas wins on 1% low frame pacing and covers both reconstruction rungs natively | ACCEPTED: PlayCanvas |
| [adr/0004-exif-orientation-normalisation.md](adr/0004-exif-orientation-normalisation.md) | Normalise EXIF orientation once at ingest so every downstream stage works from upright pixels, and record that the transform happened | ACCEPTED |
| [adr/0005-unified-selection-model.md](adr/0005-unified-selection-model.md) | One Selection primitive across person, object, place, time and trip, reached from four equal entry points | ACCEPTED |

## Current state

A real call to `nvidia/Nemotron-3_5-Lightning` on Nebius Token Factory returned HTTP 200 with the
model identifier echoed in the response body, and a real Tavily search returned HTTP 200 with its
request payload retained as evidence of data minimisation. Both were executed on 2026-08-27 and are
recorded in [runtime-verification.md](runtime-verification.md), which overrides every other document
on conflict.

The evidence spine is implemented rather than only specified: migration
`orimera/migrations/0001_spine.sql` and the `orimera/evidence/` modules, with tests. Building it
found errors in the committed design, and those are corrected in place and marked **CORRECTED**
rather than left for the next reader to trip over. The suite is 430 tests, 19 of which require a live
PostgreSQL instance and skip without one. That migration has not yet been applied against a
PostgreSQL 18 server, so every SQL-level guarantee is a text-level claim until it is.

The browser renderer is decided: PlayCanvas Engine 2.21.4, on matched-resolution measurement
([adr/0003-renderer-selection.md](adr/0003-renderer-selection.md)).

## Conventions

Every claim in this documentation set carries exactly one epistemic status, and the status is part of
the claim:

- **VERIFIED** cites a primary source URL and the date it was retrieved, or, where the fact is about
  runtime behaviour, the execution that produced it.
- **DECISION** records a choice together with the alternative that was rejected and why.
- **ASSUMPTION** is unvalidated, and names the experiment that would settle it.
- **OPEN** is unresolved, and says what would resolve it.
- **CORRECTED** marks a claim rewritten against what was actually built, naming the artefact and the
  test that forced the correction.

Two rules govern how those statuses are assigned:

- Every consequential technical claim cites a primary source with a retrieval date.
- **Agreement between sources is not evidence.** Two summaries repeating an unverified claim leave it
  unverified, and it is marked as unverified until a primary source or an execution settles it.

Some documents reference stored artifacts that are not in this repository, such as archived API
responses. Those hold account-identifying response headers and, in places, personal media, so they
are deliberately not committed; where a field in one of them matters, the document quotes it.

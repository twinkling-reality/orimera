# ADR-0002: NVIDIA text Nemotron as the reasoning core, with a non-NVIDIA vision sensor

- Status: Accepted
- Date: 2026-08-27
- Deciders: Orimera build
- Supersedes: nothing
- Related: `docs/model-and-service-selection.md`

## Context

Two facts fix the shape of this decision and neither is negotiable.

**VERIFIED.** The project is built under a platform constraint it did not choose, stated verbatim by
the programme it was written for: "All submissions must run on either Nebius Token Factory or Nebius
AI Cloud and use at least one NVIDIA open source model. Everything else is up to you." The
architecture is designed around that constraint, and every routing decision below inherits it.
Source: https://nebiusglobalaihackathon.devpost.com/rules (retrieved 2026-08-27)

**VERIFIED.** On 2026-08-31 Nebius removes ten models from Token Factory Serverless, including both
NVIDIA models that declare an `image` use case: `nvidia/Nemotron-3-Nano-Omni` and
`nvidia/Cosmos3-Super-Reasoner`. After that date **no NVIDIA vision or multimodal model exists on
Token Factory Serverless**. Nebius' own recommended replacement for both is the non-NVIDIA
`MiniMaxAI/MiniMax-M3`.
Source: https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice (retrieved 2026-08-27)

A third fact removes the option that would otherwise have been most attractive.

**DECISION already taken, recorded in `docs/product-specification.md` section 2.** The corpus is a personal
photograph library. There is no video and no audio. Combined with the verified finding that Token
Factory has zero audio capability, the "recurring voices" and "conversations" pillars are deferred.
This matters here because the single strongest argument for `nvidia/Nemotron-3-Nano-Omni` was that it
ingests video and its audio track in one forward pass and returns word-level timestamps in the same
structured output. Against a photograph corpus, that capability is worth nothing.

The system therefore needs two model roles filled: a **sensor** that turns a photograph into
structured observations, and a **reasoner** that links those observations across captures, resolves
recurring entities, and composes every user-facing answer. The question this ADR answers is which
model fills which role, and how the NVIDIA requirement is satisfied given that no NVIDIA model can
fill the sensor role after 2026-08-31.

## Options considered

**A. NVIDIA text Nemotron as the reasoning core, non-NVIDIA vision model as the sensor.**
`nvidia/Nemotron-3_5-Lightning` on Token Factory Serverless for all reasoning and dialogue,
`openbmb/MiniCPM-V-4_5` (Apache-2.0, eu-north1, carries the catalog's "JSON mode" tag) for one
structured extraction pass per photograph at ingest, with `MiniMaxAI/MiniMax-M3` as its declared
fallback. All identifiers survive 2026-08-31.

**B. Build on `nvidia/Nemotron-3-Nano-Omni` via a Dedicated Endpoint.**
The deprecation is **VERIFIED** as Serverless only; Dedicated Endpoints are explicitly unaffected.
Omni would therefore remain reachable after 2026-08-31, and it would let one NVIDIA model do both the
sensing and the reasoning, collapsing two model roles, two integration surfaces and two fallback
ladders into one.

**C. Self-host an NVIDIA multimodal model on Nebius AI Cloud.**
Run the Omni weights in a container on a GPU instance. **VERIFIED** that the NVFP4 checkpoint is
20.9 GB and the FP8 checkpoint 32.8 GB, so either fits on a single L40S (and NVFP4 stays within about
one point of BF16 across nine multimodal benchmarks). This keeps an NVIDIA model doing the vision
work and moves that work off Token Factory Serverless, where no NVIDIA vision model survives.

**D. Rejected: use a non-NVIDIA model for everything and satisfy the requirement with a token NVIDIA
call.** Listed for completeness and rejected in the same breath, because this project does not
describe itself as doing something the running system does not actually do, and a call that exists
only to tick a box is exactly that kind of claim.

## Decision

**Option A.**

- **Reasoning core, and the NVIDIA model the platform constraint requires:**
  `nvidia/Nemotron-3_5-Lightning`, Token Factory Serverless, $0.06 / $0.24 per million tokens, 1024K
  context, eu-north1, OpenMDW v1.1 per the catalog.
- **Declared fallback for that role:** `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, identical price,
  262K context, also NVIDIA.
- **Escalation tier, only on measured failure:** `nvidia/nemotron-3-super-120b-a12b`, also NVIDIA.
- **Vision sensor:** `openbmb/MiniCPM-V-4_5`, Apache-2.0, with `MiniMaxAI/MiniMax-M3` declared as its
  fallback.

The vision sensor is not an NVIDIA model. This ADR states that plainly rather than working around it.

## Rationale

### Why B was rejected

Omni's distinguishing capability is joint video plus audio with word-level timestamps. **The corpus
has neither video nor audio**, so a Dedicated Endpoint would be paying to keep a model whose only
advantage over the alternatives is unusable here.

Two further reasons, in descending confidence:

- **OPEN, and it is a real gap.** Dedicated Endpoint pricing was not established by the research. The
  qualitative shape (a reserved endpoint, billed on a different basis than per-token serverless) is
  clear enough that a reserved endpoint plainly costs more than $0.41 per full corpus pass, but no
  figure was verified and none is asserted here.
- The experiment that would have measured what is actually being lost, sending an `image_url` part to
  Omni and recording the result, has a hard external deadline of 2026-08-31. No credentials exist as
  of 2026-08-27, so it will almost certainly not run. **Choosing B would mean committing to a model
  whose behaviour on this corpus can no longer be tested before the option closes.**

### Why C was rejected

Arithmetic. **VERIFIED**: `gpu-l40s-a` `1gpu-8vcpu-32gb` in eu-north1 costs
`1.35 + (8 x 0.012) + (32 x 0.0032) = $1.548/hr` on demand.
Source: https://docs.nebius.com/compute/resources/pricing

A model server must be up whenever anyone might open the demo, and the deployment must survive
unattended from 2026-10-30 to at least 2026-12-15, about 46 days. That is
`46 x 24 x $1.548 = $1,709` for that unattended window alone, against a full-corpus inference pass on
Token Factory of about **$0.41** and a projected whole-project Token Factory spend of **$10 to $25**.

Two supporting reasons:

- **VERIFIED.** The default L40S quota in eu-north1 is 2, and it counts VMs from creation to deletion
  whether running or stopped. Reconstruction already needs one. A persistent inference GPU would take
  the other, leaving no headroom.
  Source: https://docs.nebius.com/compute/resources/quotas-limits
- Self-hosting puts a model server on the critical path of a demo that must survive 46 days
  unattended. `docs/model-and-service-selection.md` section 6 already treats unattended failure as
  the largest deployment risk; adding a GPU process to that surface makes it worse.

### Why the division satisfies the requirement

The requirement is "use at least one NVIDIA open source model". The reasoning core is an NVIDIA
Nemotron, and it is not a peripheral call: it produces **every** cross-scene continuity decision,
every entity link, and every sentence the user reads. Every branch of the routing table is NVIDIA,
including the declared runtime fallback (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) and the escalation
tier (`nvidia/nemotron-3-super-120b-a12b`), so the property holds after a deprecation-triggered
failover and not only on the happy path.

### Why the division is defensible rather than a compromise

The sensor and reasoner separation is the architecture to choose even in a world where an NVIDIA
vision model were still available on Serverless.

- **The reasoner should not look at pixels.** The Companion answers from the evidence store, not by
  re-reading photographs on every turn. A text-only reasoner enforces that structurally instead of
  relying on discipline.
- **The expensive multimodal call runs once per photograph at ingest, never per dialogue turn.** The
  vision pass is the costliest per-token model in the plan ($0.658 / $1.11 per million against
  $0.06 / $0.24). Confining it to ingest is what keeps a full corpus pass at $0.41.
- **The binding constraint on the reasoning task is context length, not modality.** The evidence
  packet is many scenes, many entity records, many evidence spans. Lightning is validated to 1M
  context at the cheapest price in the NVIDIA line. No surviving vision model on Token Factory offers
  that shape with a verified licence.
- **A text-only reasoner is swappable, and the manifest depends on that.** The deprecation mitigation
  in `model-and-service-selection.md` section 6 requires a declared same-role fallback identifier per
  role. Text roles have several candidates in the surviving catalog. If the reasoner also had to be
  multimodal, its fallback set after 2026-08-31 would be small and entirely non-NVIDIA.
- **The evidence guarantee does not pass through either model.** Every historical claim resolves to
  an address in the original bytes, not to a model output, so which model produced a description does
  not participate in the truth guarantee.

## Consequences

- **All NVIDIA usage now runs through one surface, Token Factory Serverless.** The research had
  identified self-hosted NVIDIA ASR on Nebius AI Cloud as a second, independent path that also
  exercised AI Cloud. That path is gone with the audio pillar, so a Serverless-wide outage or a
  further deprecation has no second surface behind it. This is a genuine loss and is recorded as one.
- **OPEN.** Whether to self-host `nvidia/Nemotron-3-Embed-1B-BF16` (OpenMDW-1.1) as the text embedder
  in place of `Qwen/Qwen3-Embedding-8B`. It would close the fallback gap for the embedding role. It
  has not been costed, and it must not displace `Qwen/Qwen3-Embedding-8B` for any reason other than
  measured retrieval quality.
- **CLOSED on 2026-08-27.** One successful chat completion against
  `nvidia/Nemotron-3_5-Lightning` is archived with its echoed `model` field, so the project may now
  describe this routing in the present tense. See `docs/runtime-verification.md` section 1 and
  `docs/model-and-service-selection.md` section 7, which still binds any identifier that has not
  itself been called.
- **ASSUMPTION.** That `nvidia/Nemotron-3_5-Lightning` is sufficient for cross-scene continuity
  resolution, so one text model can serve both dialogue and reasoning. Validation: run the continuity
  task on Lightning and on `nvidia/nemotron-3-super-120b-a12b` over the same evidence packets and
  compare against user-confirmed ground truth. If Lightning holds, the routing surface stays at one
  model.
- **ASSUMPTION, and the one that could force this ADR to be revisited.** That
  `nvidia/Nemotron-3_5-Lightning` honours `response_format: json_schema` reliably. **VERIFIED**: no
  surviving text Nemotron carries the catalog's "JSON mode" tag, and the live OpenAPI spec's own
  `response_format` description contradicts the documentation page on `json_schema` support. If
  structured output fails on Lightning, extraction moves to `Qwen/Qwen3-235B-A22B-Instruct-2507` and
  the NVIDIA model's role narrows to prose reasoning that a second model structures. That widens the
  routing surface to two models for a task the plan budgets for one. Validation: 20 identical
  nested-schema requests with `strict: true`, then the same 20 through `extra_body.guided_json`.
- **Ultra is not in the default route.** `nvidia/Nemotron-3-Ultra-550b-a55b` costs 15.48 times as
  much as Lightning for an identical 8,000-in / 800-out turn, and Lightning already carries the same
  1024K context. This project will escalate to Ultra only when a measurement justifies it, and will
  record the measurement next to the change. Arithmetic in `docs/model-and-service-selection.md`
  section 5.2.

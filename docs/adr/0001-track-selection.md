# ADR-0001: Submit to the Best Apps and Agents track

- Status: Accepted
- Date: 2026-08-27
- Deciders: Orimera build

## Context

The handoff brief names the track as "Best Apps & Agents". Verification against the official Devpost
pages on 2026-08-27 shows the exact name is **"Best Apps and Agents Track"** and that four tracks
exist, two of which plausibly fit Orimera.

The rules constrain award stacking:
> "Each Project is eligible for one Overall Award OR one Track Award and one Bonus Award."

## Options considered

**A. Best Apps and Agents Track.** "Build any app or agent someone would actually use, from a
productivity tool or copilot to a workflow that runs itself." Track guidance explicitly points at
Nemotron 3 Ultra for reasoning with Nano or Super for fast calls, which matches the routing Orimera
needs for a conversational Companion plus hard cross-scene reasoning.

**B. Personal AI Track.** "Build an always-on, private assistant that works for you while keeping
your data under your control." Superficially attractive: Orimera is deeply personal and is built
around a user's own data.

**C. Physical AI Track.** Rejected immediately. Orimera has no embodied or edge component, and the
track additionally requires a minute of footage of hardware operating.

**D. Coding and Agentic Engineering Track.** Rejected immediately. Not a developer tool.

## Decision

Submit to **Best Apps and Agents**.

## Rationale

Option B fails on honesty, which is the project's governing constraint. The Personal AI track asks
for something "always-on" and "keeping your data under your control". Orimera is explicitly not
always-on: the brief excludes background and always-on recording from the MVP. It is also explicitly
forbidden from claiming privacy, on-device processing, or local-only control that it does not
implement, and its architecture sends media to third party cloud APIs. Entering a track whose framing
the product contradicts would force exactly the overclaiming the brief prohibits.

Option A is the honest description of what Orimera is: an application someone would actually use.
Its track guidance also matches the intended model routing, which strengthens the Technological
Implementation criterion.

## Consequences

- The Tavily bonus ($3,000) stacks with a Track Award but not with an Overall Award. The Tavily
  integration must therefore be genuinely useful rather than decorative, since it is worth more than
  the Jetson track prize it stacks with. This reinforces the brief's existing narrow past to present
  scoping rather than changing it.
- Judging criteria are equally weighted, and Design plus Potential Impact are half the score. This is
  evidence for prioritising the Atlas, the Companion, and the evidence spine over model count.
- "based on what's demonstrated" ties scoring to the 3 minute video. The demonstration contract is a
  design input from the start, not a packaging step at the end.

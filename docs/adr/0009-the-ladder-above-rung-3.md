# ADR-0009: How the ladder earns rungs 1 and 2, and what a posed rung 3 is

- Status: **ACCEPTED as a design; partially implemented.** The pose backend exists and runs
  (`orimera/reconstruction/pycolmap_executor.py`). Everything else here is decided and not built.
  Each decision names what it would touch, so that building it is execution rather than reopening.
- Date: 2026-09-03
- Deciders: Orimera build. Four independent proposals were scored by judges on honesty, on the
  metric frame and query path, and on what could be implemented now on this machine.
- Supersedes: nothing wholesale. It corrects two sentences in place, named in D2 and D3.
- Related: [product-specification.md](../product-specification.md) section 5;
  [reconstruction-findings.md](../reconstruction-findings.md);
  [colmap-pose-jobs.md](../colmap-pose-jobs.md);
  [corridor-navigation-artifacts.md](../corridor-navigation-artifacts.md);
  [gsplat-scene-jobs.md](../gsplat-scene-jobs.md);
  [adr/0008-generated-geometry.md](0008-generated-geometry.md);
  [adr/0010-opm-2.md](0010-opm-2.md).

## Context

The ladder has four rungs and, until this work, one producer. `decide_rung` awards rung 3 or rung
4 from one photograph. The controllers for the rungs above it exist and are contract tested, and
until now none of them had a backend: `pose` shelled out to a `colmap` binary that is not
installed anywhere in this project, and `splat` delegates to a container entrypoint nobody has
built. Nothing in `orimera.ingest` calls any of them, so no rung above 3 has ever been published.

Three measurements from [reconstruction-findings.md](../reconstruction-findings.md) shape every
decision below.

**Pose recovery is cheap and local.** Eight views register in 3 to 4.5 seconds on this laptop's
CPU, with no CUDA. Three adjacent frames are the minimum that registers under COLMAP's defaults.
So the expensive-sounding half of the ladder is the affordable half, and it runs where the
photographs already are.

**Scale is the hard part, not pose.** COLMAP's frame is scale ambiguous, and the pose controller
requires a measured scale that nothing produces. MoGe-2 recovers metric depth per image, so it is
the obvious candidate. Measured against a known scale it was 9.0 percent high using MoGe's own
field of view and 18.1 percent low when the true field of view was supplied, while the spread
across images stayed near 3 percent in both cases. **Agreement between views is precision, not
accuracy.** A spread gate would have passed an estimate that was a fifth wrong.

**One viewpoint covers about three quarters of its own box and fills most of what it sees.** The
answer to an empty region is another photograph, not a better renderer and not a generator
(ADR-0008).

## Decision

**D1. The gate is layered, and `decide_rung` does not grow branches.** It sees one prediction from
one photograph and keeps awarding 3 or 4. Rungs 1 and 2 are facts about a set of photographs and
cannot be read off a single frame however the branches are written, so a separate pure scene gate
composes the pose receipt, the scale receipt, the coverage analysis, the corridor receipt and the
splat receipt where one exists into 1, 2 or 3, recording every reason. It stores its own decision
as a digested artifact naming every receipt digest it read, so a rung can be re-evaluated from
stored receipts without re-running COLMAP.

**D2. Rung 2 does not require a splat, and this is a correction to the specification rather than a
new ladder.** The specification's rung 2 row describes the producer as "the same splat" with thin
coverage. The code already disagrees with it in the right direction: `navigation.py` publishes
`published_rung = 2` whenever the corridor artifact's own measurements are accepted, and a splat
appears nowhere in its inputs. What defines the rung is its fourth column, what the user gets: a
camera move along the path actually walked, with real parallax and freedom to look around. Two
substrates deliver that column, and the artifact records which:

| Substrate | What is drawn | What the corridor binds to |
| --- | --- | --- |
| `splat` | An accepted rung 1 splat whose coverage is one sided or thin | the SOG delivery digest |
| `posed-relief` | The posed monocular point maps of D6 at their recovered cameras | the placement record digest |

This matters because it is the difference between rung 2 needing a GPU that has never been
provisioned and rung 2 running on a laptop in seconds. The substrate is carried into the displayed
sentence so that nobody is told posed relief is photoreal. `SplatQuality.fallback_rung` stays
`Literal[3]`: a failed splat does not become a corridor by falling over, it becomes a corridor only
if a corridor was measured.

**D3. A scene-level threshold that changes only the label leaves the idempotency key. A
per-capture one does not, and this distinction is the whole decision.** Today every tunable number
lives in stage params, so editing one regenerates every artifact. That is right for a parameter
that changes the bytes, such as the silhouette threshold. It is also right, today, for the rung 3
threshold, and moving that one would be a mistake: the per-capture rung is a persisted assertion
written once during ingest, and the stage returns early when it reuses an artifact, so a threshold
outside the key would change no stored rung at all and the displayed rung would silently disagree
with the profile that supposedly set it. **The rung 3 threshold stays in stage params until a
recompute path exists for the assertion.** Only the scene gate's own thresholds, which are read at
derivation time from stored receipts, move into a frozen digested profile that the gate records
alongside its decision, so a scene threshold change is a named re-label rather than a silent one.

**D4. An unmeasured threshold is `None`, and `None` blocks the rung it guards.** This is the rule
`quality.py` already applies to observations, applied to thresholds: a missing measurement is not
a missing check. The gate refuses with a reason naming the field. It converts the anti-guessing
protocol from a convention that a reader must honour into a structure that fails. Every threshold
this design needs is unmeasured today, so on the day it is built it publishes rung 3 with reasons,
which is the honest state of a pipeline whose numbers do not exist yet.

**D5. The metric scale is its own receipt, it never opens the query path, and it does not relax
the splat gate.** The scale receipt binds to the pose receipt's digests and records its method by
name, so a human-measured scale and a model-derived one are distinguishable facts rather than one
number. A model-derived scale may size corridors, agent radii and clearance, where a 10 percent
error widens a corridor by 10 percent and is capped and reviewable. It may not answer a spatial
question: `scaleIsMetric` stays false and `asMetricLocal` keeps returning null until a scale is
validated against a distance somebody physically measured. Precision is not accuracy, and R-48 is
about what may be measured across, not about how confident the model sounded.

Two things follow that are easy to get wrong, so they are stated rather than implied.

- **The splat controller's requirement for a reviewed positive measured scale is not relaxed.** It
  is the single place that requirement is enforced, and a scale receipt may substitute for the
  manifest scale there only when the receipt records a physical reference. A model-derived receipt
  never promotes a scene to a shared metric frame.
- **Agreement between views is not the acceptance test.** The measurement that motivates this
  decision had a three percent spread around a nine to eighteen percent error, so a spread gate
  would have accepted it. A model-derived receipt is accepted for corridor sizing on the basis
  that its error is bounded and its effect is capped, and it is recorded as unvalidated. Making
  spread the criterion would reintroduce, as the gate, the exact inference this decision rejects.

**D6. A posed multi-view set is a rung 3 sub-state over unchanged OPM/1 files.** The specification
already says rung 3 point maps are "placed at recovered poses where they exist". Placement is
therefore not a container change: the files stay byte identical with their origin viewpoints, and
a separate digest-bound placement record names its members by content hash and says where each
stands. Each shell is rescaled to the scene consensus, because per-view scale differed by up to
20 percent in measurement, and a shell that disagrees with its neighbours is left on its anchor
rather than drawn twice. The cross-language fixture is not regenerated by this decision.

**D7. Coverage is measured, and every coverage number carries the convention that produced it.**
The same committed point map yields 27.1, 35.4, 36.1 or 51.4 percent at a 12x12 grid depending
only on the support floor and the bounds rule. A number whose definition travels separately from
it is a number that will be compared with the wrong thing, so the grid, the bounds rule and the
support floor are recorded fields of the coverage record rather than constants in a module. The
analysis reads the sparse model and the scale receipt and never splat pixels or opacity, which is
the rule the corridor document already states.

**D8. Corridor inputs are measured from triangulated geometry, per side of the path, and
monocular geometry may only narrow a corridor.** Clearance at a sample is evaluated separately in
the left and right sector of the camera forward, as the smaller of the distance to the nearest
well-tracked sparse point and the distance to the nearest supported monocular point, and **a
sector with too few supported points is assigned clearance zero.** Unseen space therefore
contributes no width at all. That is the designed void enforced in the artifact rather than in the
shader. Slope is centreline slope between consecutive camera centres and is named as such, because
no ground surface is identified anywhere in this pipeline and relief never becomes an invented
floor. The look envelope is derived from the members, half the smallest horizontal and vertical
field of view across registered cameras, so the envelope provably never leaves what the cameras
saw and needs no unvalidated constant.

**D9. A fact about a set needs a subject, and deletion has to reach it.** Every artifact today is
keyed to exactly one source blob, which is what the purge cascade and the export projector join
on. A pose receipt, a splat and a placement record are facts about N photographs and have no home
in that scheme. They get one: a scene identity with an explicit many-to-many source relation, a
scene-level rung assertion whose support spans are the whole-image spans of every registered
member, and a tombstone path that reaches a scene artifact through any of its members. **No
scene-level artifact ships before the test that deletes one of N members and asserts the bytes are
released and the export changes.** The reduction over a group changes with it: worst-first stays
right for panels, because a hole is a hole, and is wrong for a scene, because four unregistered
photographs are not holes in a corridor, they are photographs that open as photographs.

**D10. Nothing above rung 3 reaches a viewer until something serves geometry at all.** There is no
production path by which any point map reaches the renderer: no route serves artifact bytes, and
the only loader in the workspace is a development preview, while the app's own comment claiming
that production reads point maps from an API describes an implementation that does not exist. So a
posed set, a corridor and a designed void would all be built against nothing. **The delivery route
is the first item of work, before any of the above**, and it carries the authentication and digest
rules that the residency design already assumes: bytes in hand, a bearer in the header, and the
content hash verified against the descriptor that named it.

**D11. The rung is displayed, from the recorded claim rather than from the container.**
Specification 5.1 says the rung is shown as part of a region's identity and calls it the honesty
feature. It is not shown anywhere: the four rung sentences in the app's copy table are referenced
by no render site, a second and divergent copy table exists in the formation package, and the
server's terminal formation event hardcodes rung 4.

**The deeper problem is not the missing render site, it is where the rung comes from.** The app
derives a region's rung by reading the field off the decoded point map, and that field is pinned
to 3 by the container. So the client can only ever conclude rung 3 for a region with geometry, no
matter what the pipeline measured, and a scene gate that awarded rung 1 or 2 would change nothing
a viewer sees. The rung has to arrive as the recorded claim, which is where the gate writes it.
**This is the prerequisite for every other decision here**, because a ladder that earns a rung
nobody sees has added a claim without adding the honesty that justifies it. One copy table, one
render site, the recorded assertion rather than the container constant, and the measurements shown
beside the label.

**D12. A pose job directory holds photographic derivatives outside the deletion cascade, and this
is a gap the pose backend just made real.** A COLMAP job writes a working database holding SIFT
descriptors of every image it was given, alongside the sparse model, in a directory keyed by the
manifest digest and known to nothing else in the system. Nothing registers it as an artifact, so
no tombstone reaches it, and descriptors of a photograph containing a person are exactly the kind
of derivative the privacy model expects to be destroyed. **The job directory is deleted when the
receipt is accepted, and until a scene artifact exists to carry it, no pose job may run over a
capture set outside a scratch location that is purged on a timer.** This is stated as a decision
rather than a future concern because the executor that makes those directories now exists and
runs.

## Alternatives rejected

- **Grow `decide_rung` with rung 1 and 2 branches.** Its input is one prediction; it would have to
  take receipts it cannot relate to the photograph, and the test that pins it to `{3, 4}` would be
  broken by design rather than by evidence.
- **Flip the splat gate's fallback so a thin splat publishes rung 2.** Quickest, and it awards
  movement that no corridor validated. The corridor is what measures the envelope; a splat's
  failure to be good enough for rung 1 says nothing about where a walker may stand.
- **Derive the rung at read time from raw facts, with no stored gate decision.** Attractive because
  a threshold change re-labels without regenerating, which D3 adopts for label-only thresholds. As
  a whole design it was rejected because a rung with no stored derivation cannot be verified from a
  package by a third party, which is what the World Memory Package is for.
- **One artifact row per contributing capture, all sharing a content digest.** Deletion closure
  becomes free and the identity scheme is untouched. Rejected because the count of rows becomes the
  count of photographs times the count of scene artifacts, and because a set with no identity has
  no subject for a scene rung claim; the many-to-many relation is the thing that is still right at
  a hundred thousand photographs.
- **Let MoGe-2's metric scale set `scaleIsMetric` once views agree.** Rejected by the measurement
  that motivated it: agreement was 3 percent while the error was 9 to 18 percent.

## Consequences

- Rung 2 becomes reachable on a laptop, from three or more overlapping photographs, with no GPU
  and no trained splat. Rung 1 stays blocked on a GPU job that has never run and on a resumable
  trainer that does not exist.
- The scale of the world this is designed for is not the scale the interface currently admits. The
  layout solver refuses more than five islands, and this record does not lift that: a design that
  is right at a hundred regions is being chosen deliberately while the cap stays where it is,
  because lifting it needs a layout measurement that nobody has made.
- Every rung above 3 published on the day this is built is published as rung 3 with reasons,
  because every threshold it needs is unmeasured. That is the design working, not failing.
- The fraction of a real library that can reach rung 2 is unknown and is the number the product
  most needs. Published proxies bracket it between 1.6 and 25 percent.
- Displaying the rung is now on the critical path rather than beside it.

## What must be measured before this is final

- The MoGe-2 to COLMAP scale ratio on photographs rather than renders, per image and across
  images, which decides whether a scale receipt can ever be more than an ordering hint.
- pycolmap on real photographs on this machine: registration rate, the minimum image count that
  registers under defaults, and wall time at full resolution for 8, 20 and 50 images.
- The filled fraction of the frustum union for a real multi-photograph capture, against the
  single-photograph decomposition already measured.
- Every threshold named in D3 and D4, each against a corpus that does not exist yet.
- The deletion test of D9, before any scene-level artifact ships.

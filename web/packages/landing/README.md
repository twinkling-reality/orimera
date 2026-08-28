# @orimera/landing

The signed-out landing page, the entrance transition into an unformed Atlas, and the processing
formation states.

```
pnpm --dir web landing          # dev server
pnpm --dir web landing:build    # production build
```

## Why this package has no renderer

ADR-0003 is unresolved. A signed-out page that imported a 3D engine would prejudge it, pay for it
on first paint, and have to be rewritten if the ADR lands the other way. So the atmosphere is a 2D
canvas particle field and nothing here names three.js, Spark, PlayCanvas, `@orimera/atlas-three` or
`@orimera/atlas-react`.

That is enforced, not intended. Two rules in `web/.dependency-cruiser.cjs` fire on it:
`landing-imports-atlas-core-only` and `engine-specific-code-stays-behind-the-binding`. Both have
been probed with a deliberate violation and both report by name.

The one workspace dependency is `@orimera/atlas-core`, for the epistemic vocabulary
(`ProvenanceClass`), the reconstruction ladder (`rungProperties`) and `phyllotaxisSeed`, which is
the same deterministic seed the real layout solver uses. The landing page therefore cannot describe
the product in terms the application does not share.

## One field, for the whole session

`interaction-model.md` 1.1: "There is exactly one scene graph, one camera and one render loop for
the entire lifetime of a session, from the landing page through to any region interior. There is no
scene loading, no 'enter' and no 'return'."

This package is the 2D echo of that. There is one canvas, created once and never torn down. The
landing composition, the entrance transition and the unformed Atlas are the same 1500 particles
holding a different **figure**. Entering animates four numbers (ground, zoom, and two offsets) and
hands the field a new figure. Nothing unmounts, nothing navigates, and the material in front of the
visitor afterwards is the material that was in front of them before.

The ground inverts across the move: pale on the signed-out page, deep inside the Atlas. It is a
continuous lerp of one palette rather than a theme switch, so the entrance reads as travelling from
daylight into an interior.

| File | What it holds |
| --- | --- |
| `src/atmosphere.ts` | the loop, the compositions, the entrance and its reverse |
| `src/field/particles.ts` | the particle field: springs, morph stagger, between-space drift |
| `src/field/figures.ts` | the Companion, the unformed Atlas, and the formation figures |
| `src/field/renderer.ts` | canvas 2D: two half-resolution luminance masks, gradient tint, grain, vignette |

### Cost, measured rather than assumed

**3.35 ms per frame**, measured in Chrome on the stated target machine (Apple M3 Pro) on
2026-08-27. Method: the renderer's exact per-frame draw sequence (ground gradient, 1500 sprites
into two half-resolution masks, two gradient tint composites upscaled to full resolution, grain
pass, vignette) run 60 times at 1920 x 1260 device pixels, with a one-pixel `getImageData`
readback afterwards so the GPU work is flushed rather than left queued. That is about a fifth of a
60 Hz budget, on the ground where the ink is darkest and the compositing does the most work.

Two decisions carry most of that. The masks are rendered at half resolution and upscaled, which is
where the diffusion comes from as well as three quarters of the fill rate; and the device pixel
ratio is capped at 1.5, because this field is soft by design and gains nothing visible above it.
The particle count is fixed for the session rather than adaptive, because a field that quietly
thins out when the machine is busy is a composition nobody can review.

### The Companion motif

Five to four thin concentric rings around a suspended luminous core, with a haze skirt below. This
is the form `interaction-model.md` 4.1 specifies for the Companion's in-world presence: no face, no
eyes, no limbs, no anthropomorphic proportions. It is an original abstract form defined by this
project's own design document. The core is deliberately offset from the ring centre rather than
concentric with it, which is what stops tilted ellipses around a bright point from reading as an
eye.

## Reduced motion

Not a degraded page. Under `prefers-reduced-motion: reduce`:

- the field holds its figure exactly, with no integration and no drift;
- the grain stops crawling but stays, because the grain is texture and the crawl is motion;
- the entrance is a 260 ms cross-fade with the ground and figure swapped instantly;
- an **arrival caption** appears, because the information the movement carried has to be restated
  in words (`interaction-model.md` section 9);
- the formation labels are byte-identical to the motion path. `formationLabel` takes no motion
  argument at all, and a test asserts its arity, so no wording can ever branch on the setting.

The setting is watched, not sampled at load, so changing it mid-session takes effect.

## The formation states

`src/formation/` is pure TypeScript with no DOM, testable headless, and it is the part of this
package meant to outlive the landing page.

```
events.ts       the wire contract: stage, index, counters, detections, outcome, timestamp, event id
state.ts        the reducer, plus progressFraction and elapsedMs
labels.ts       the honest label for every state
visual.ts       state to FormationVisual, which is what a renderer reads
source.ts       the FormationEventSource interface
mock-source.ts  MOCK. The only file here that invents a number, and its name says so.
```

### The rule the whole module exists to keep

`interaction-model.md` 8.1: "Every visual formation state is paired with a factual label naming the
real pipeline stage and the real unit of progress. There is no synthetic progress bar and no
invented percentage."

Three absences carry it:

1. **No timer.** Nothing advances between events. If the pipeline goes quiet the state stops
   changing, which makes the "freeze on stream loss" rule (8.4) free rather than a special case.
2. **No interpolation.** `counters` is whatever the last event carried. A burst from the backend is
   a jump on screen, by construction.
3. **No default for an unknown total.** `progressFraction` returns `null`, and the panel renders
   `null` by removing the meter entirely. Not an empty meter, not a meter at zero, not an
   indeterminate barber pole: the absence of the control is the honest rendering of an absent
   number.

`ASSUMPTION A-29` (whether the pipeline can emit real per-stage counters) is still open. This
client is built so the answer changes the data and not the code: a stage that reports no counters
already renders as a breathing figure plus elapsed time, and the `stream_loss` and unmeasured
`reconstruction` paths in the mock exercise it.

### States

| Phase | Figure | Label pattern |
| --- | --- | --- |
| `received` | dim void volume, motes drifting inward | "Received 148 photographs. Not yet processed." |
| `media_extraction` | motes aligning onto a faint disc | "Reading images: 62 of 148." |
| `camera_recovery` | thin frusta along the recovered trajectory | "Estimating camera positions: 91 of 148 registered." |
| `reconstruction` | motes migrating onto surfaces | a fraction when one exists, otherwise elapsed time |
| `entity_indexing` | one mote per detection | "Found 12 people, 4 objects, 2 places." |
| `continuity_search` | one catenary thread per compared link | "Comparing with 2 existing regions. 2 compared." |
| `review_required` | formed, unconfirmed anchors dissolving | "N things need your confirmation before it can support an answer." |
| `ready` | formed | "This region is ready. 7 things I am unsure about." |
| `partial` | formed, thinner | "Formation stopped at X. The partial region is kept and is enterable." |
| `failed` | settled and dim | "Camera pose estimation failed after 91 images. The photographs are available." |

Counts in the geometry are real counts. Anchor motes are one per detection up to a legibility cap
(`ANCHOR_MOTE_CAP`), above which the label carries the true number and the geometry stops. The
frusta are a fixed sampling of the trajectory whose **extent** grows with the measured fraction, so
they imply no count at all: a number the eye could read off the picture would be a second, weaker
channel for something the label already states exactly.

### Wiring it to the real ledger

Replace one constructor. The interface is in `source.ts` and the real implementation is an
`EventSource` over the provenance ledger, resumed from `state.lastEventId`. The mock already
exercises the resume path, so reconnect behaviour is not being written for the first time against a
live stream. Anything that mounts the mock must show `MOCK_BANNER`; the sample world is a replay of
the same scripted events through the same reducer, so it cannot drift from what the live path
produces.

## Tests

`test/formation-state.test.ts` covers the reducer and the state-to-visual mapping.
`test/formation-labels.test.ts` replays every mock scenario in both stream states and asserts that
no label anywhere prints a percentage, an estimate of time remaining, a banned retention word or an
audio claim, and that the rung copy implies free movement only for the rung that earned it. `test/figures.test.ts` asserts that the geometry carries the real counts.

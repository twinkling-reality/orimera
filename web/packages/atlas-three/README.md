# @exulanica/atlas-three

The three.js r185 + Spark 2.1.0 renderer binding: **ADR-0003 option A**, built so the bake-off can
measure it rather than argue about it.

This is a *candidate* implementation of the `atlas-react` contract, not a replacement for it.
`atlas-react`'s own barrel records that "two competing implementations of this package are the
bake-off", so the engine-specific half lives here under its engine's name, and the ADR can be
settled by deleting a package rather than by unpicking one. `.dependency-cruiser.cjs` enforces
that: only `atlas-three`, `atlas-react` and `bakeoff` may name a renderer at all.

## What is here and what is deliberately not

| Here, because it is engine-specific | Not here, because atlas-core already decided it |
| --- | --- |
| the WebGL renderer, canvas and frame loop | the scene graph and island frames |
| the point material and its GLSL | focus resolution and the aim/distance/importance weights |
| the `.opm` to GPU-buffer path | view manifest application and the emphasis scalar |
| the camera rig and pointer-lock look controller | representation tiers and their hysteresis |
| the occupancy grid and the walker | the layout solver |
| the DOM anchor overlay and presence markers | the coordinate frames and their one-way conversion |

Nothing in this package reimplements a decision atlas-core already made. That is what makes
"switching engines is a two-package rewrite" true rather than aspirational.

## The graphics path, stated because it is the ADR's main cost

**WebGL2. Not WebGPU, on a machine where WebGPU is available.**

`SparkRendererOptions.renderer` is typed `THREE.WebGLRenderer` and there is no WebGPU
constructor, so choosing three.js + Spark chooses WebGL2 for the whole application, not just for
splats. `capabilities.ts` probes for a WebGPU adapter anyway and the harness prints
`webgpuAvailable: true` in bold, because "WebGPU was available and we did not use it" is a
different fact from "WebGPU was not available" and the ADR needs to be able to tell them apart.

On the demo machine the probe reports:
`ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)`, WebGL2, WebGPU adapter **available and
unused**, `EXT_disjoint_timer_query_webgl2` present, `performance.memory` present.

## The six requirements, and where each one lives

**1. N independently transformed islands in one canvas.** `AtlasRenderer.addIsland` appends to a
live scene graph that is never reloaded. There is no `load`, no `enter` and no `return` in this
API, because interaction-model.md 1.1 has exactly one scene for the whole session and four of its
five consequences are unimplementable on top of a renderer that swaps scenes. Each island's
placement is applied as the object's own matrix, so relocating one on a rare persisted layout
change costs a matrix rather than a re-upload of 72 MB.

**2. First-person controls, reticle-based.** `controls/pointer-look.ts` reads `movementX` and
`movementY` and nothing else from a mouse event, because Pointer Lock 2.0 freezes `clientX` and
`clientY` while locked. There is no hover path anywhere in this package and there cannot be one.
It never binds Escape (the browser owns the unlock gesture) and never auto-relocks (re-locking
needs transient activation, so `requestLock` is only ever called from a real click on the resume
button). `controls/walker.ts` is WASD with a critically damped ramp, a sprint modifier, automatic
step assist, and **no jump**: there is no vertical velocity in the file at all, which is the
strongest way to stop one being added back by accident.

**3. Containment, for a substrate with no collision mesh.** Two layers, because neither is enough
alone.

- Layer 1, `containment.ts`: one linear pass over the positions at load builds three coarse grids
  per island. `floor` is the **minimum** supporting height in each column, not the maximum, because
  the maximum is a roof or a mast and would teleport the walker onto the skyline. `obstruction`
  counts points in the body band (floor + 0.4 m to floor + 1.9 m), so a wall, a crate or a moored
  hull all read as impassable. `support` distinguishes **unobserved from empty**: a column the
  camera never saw is a refusal, not a hole to fall through. Segment class decides what counts, so
  water blocks outright and a person is ignored entirely, because a presence marker must never
  become a wall.
- Layer 2, an authored soft boundary radius that damps outward velocity in the between-space,
  where layer 1 has nothing to say. ADR-0003 fixes this layer as required regardless of engine.

Blocked moves slide along the free axis rather than stopping dead. The grid build is deliberately
**not** in the first-frame path: it is queued and drained by `drainDeferredWork()`, so it cannot
hide inside time-to-first-meaningful-render, and its cost is reported separately (8 ms at 250k,
99 ms for three islands at 4M).

**4. The dissolving particulate boundary.** In `render/point-shader.ts`. The outer fifth of the
footprint is a dissolve band using atlas-core's own `DISSOLVE_BAND_FRACTION`, and beyond the
footprint the cloud decays exponentially into abstract space rather than stopping at a wall.
Depth fog mixes toward the between-space colour. Every soft edge is resolved by **stochastic
alpha**: a per-point stable hash decides whether the point exists this frame, so the material is
opaque, writes depth, needs no sort at any point count, and dissolves by losing specific points
rather than by fading. The grain is stable per point and is not re-seeded per frame, because
temporal dithering looks better in a still and is a comfort defect in motion.

**5. Per-point semantic state.** `semantic-state.ts`. Appearance is driven by two independent
real inputs: the reconstruction's own per-point confidence, which arrives in the colour buffer's
alpha channel, and the entity graph's link state, provenance and confidence for the segment the
point belongs to. An unconfirmed candidate loses alpha **and** scatters in space **and** thins
out, so it reads as unresolved rather than as merely dim. The graph state is *not* a per-point
attribute: each point already carries a segment id, and the state is a 256x1 RGBA8 lookup
texture, so a merge, a confirmation or a recomposition writes **1 KB** and flags one texture.
Rebuilding a 4M-point attribute buffer per hover would be four orders of magnitude more work for
the same picture.

Two rules are enforced by construction rather than by care:

- **People are not baked into geometry.** The point material culls every point whose segment class
  is `person`, and `render/presence-markers.ts` draws a time-anchored citation card instead. The
  two halves are in different files on purpose: disabling the marker gets you no person, never a
  silently reconstructed one. When no crop has loaded the card says "source crop not loaded"
  rather than showing a silhouette, because a silhouette is a picture of a person we do not have.
- **Mute, do not hide.** Emphasis exactly 0 (`hidden`, reserved for deleted content) culls;
  everything else ramps to a floor. `normal` maps to **full** alpha, not to 0.45: a world with no
  query active has to look solid, or the user reads the resting state as uncertainty.

**6. Screen-space anchors.** `overlay/anchor-overlay.ts` projects world positions by hand each
frame into DOM nodes that were all allocated in the constructor, and writes `style.transform`.
Hard caps: **1 focus label, 6 pinned callouts, 4 edge chevrons**, then "+N more, open World
Index". The collision pass pushes overlapping callouts in fixed increments with an SVG leader
line back to the true projected point, and it never calls `getBoundingClientRect`, because a
layout read inside the render loop is the exact cost this design exists to avoid. Behind-camera
points are gated before projection, since the perspective divide flips sign behind the viewer and
would otherwise place them at a plausible-looking mirrored position.

Anchors never carry a name (the occurrence is anonymous, the entity holds the name), so the
overlay takes an injected `NameResolver`. The binding therefore depends on no graph transport and
stays testable with a stub.

## Spark

`spark-island.ts`, behind a dynamic import, and **untested against real splat bytes** because no
splat fixture exists in this repository yet. The fixture the bake-off measures is a point map,
which is rung 3 and explicitly not splats; scene-synth rejected encoding points as degenerate
splats because it "would tilt the bake-off toward whichever engine has the better splat path".
So Spark is not in the hot path of any number reported here, and saying otherwise would make the
bake-off answer a question it did not ask.

What the module is for: the rung-1 path, wired so that when experiment X-1 produces a real baked
splat, the same scene graph, placements, anchor overlay and focus solver render it with no
restructuring. A splat island and a point island are both `Island`s in one `AtlasScene`.

## Spec gap found while building this

**`atlas-core`'s `Anchor` has no field naming the region of a capture that a detection covers.**
Requirement 4 needs one: without it, per-point dissolve can only be driven by the reconstruction's
own confidence and not by link state, which is the half that actually matters. The binding works
around it with an explicit `SegmentBinding` table plus an alias map supplied by the caller
(`bindSegmentsByName`), matched by exact name and never by substring, because a substring match
between a detector's label and an anchor id is exactly how a scene ends up with the wrong dissolve
on the wrong object. The id belongs in the graph, not in a renderer.

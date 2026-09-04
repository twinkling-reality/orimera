# @exulanica/bakeoff

The ADR-0003 **X-R1** harness for the three.js + Spark binding.

```
pnpm synth --out ./fixtures        # once: writes the 250k / 1M / 2M / 3M / 4M ladder, ~10 s
pnpm bakeoff                       # dev server on 5173
```

Then open it **in a real, foreground Chrome window**. That is not a formality, see below.

## URL parameters, because it has to be automatable

| URL | What it does |
| --- | --- |
| `/?run=ladder` | the whole ladder, then a summary, then POSTs the result to the dev server |
| `/?points=1000000` | one rung, measured, then hands the world to the walker |
| `/?points=4000000&islands=1` | the pure single-island rung |
| `/?walk=1&points=1000000` | no measurement: the "is it a place worth walking in" question |

Also `&islands=1..3` `&warmup=1500` `&measure=6000` `&dpr=2` `&motes=0` `&people=1` `&post=1`.

Console output is prefixed and parseable, one JSON object per line:

```
EXULANICA_BAKEOFF_ENV     {...}   capabilities and the full configuration
EXULANICA_BAKEOFF_ROW     {...}   one per rung
EXULANICA_BAKEOFF_SUMMARY {...}   the whole set, once, with its caveats attached
```

`window.exulanicaBakeoff` carries the same objects plus the live renderer, for a driver that would
rather read a value than parse a transcript.

## The result sink, and why it exists

ADR-0003 X-R1 step 3 requires the run to happen "in visible Chrome with the window in the
foreground, because a hidden render pane throttles `requestAnimationFrame` and invalidates the
numbers". A foreground window is exactly the window whose console an automated driver cannot
read. So the page POSTs its own summary to `/__bakeoff/result` and the dev server writes it to
`web/bakeoff-results/latest.json`. The run is foreground **and** automatable instead of one or
the other.

**This was not a hypothetical.** Run inside an embedded render pane, `document.visibilityState`
reads `hidden`, `requestAnimationFrame` advances only when the pane is forced to paint, and the
harness correctly reported every window as `spoiled`. The numbers below are from a real Chrome
window and carry `visibleAtStart: true`.

## What the harness refuses to do

Each of these would produce a number that flatters the answer:

- **It does not measure the point cloud alone.** scene-synth's own note: "a binding that only
  draws points measures half the frame budget." The overlay projection, the focus solver, the
  emphasis buffers, the tier resolver and the presence markers all run inside every measured
  frame.
- **It does not use a static camera.** `camera-path.ts` is a deterministic three-phase path
  identical at every rung: a near-field dolly (maximum overdraw), a full rotation in place (every
  point crosses the frustum, so culling gets no free wins), and a retreat into the between-space
  looking back (every island in view at once, which is the Atlas overview case the cross-asset
  budget argument in ADR-0003 is really about). Two bindings compared on two different camera
  paths have not been compared.
- **It does not discard a spoiled window.** Visibility loss is detected and the row is *reported*
  as spoiled. A silently discarded sample is how a benchmark ends up measuring only its good
  moments.
- **It does not report a GPU memory figure.** No browser API exposes VRAM. What it reports is
  `uploadedBytes`, the exact byte count this binding uploaded, labelled as a lower bound, plus
  three.js's own `renderer.info` counts. Calling that "GPU memory" would be the single easiest
  place here to publish a fabricated number.

## Measured, 2026-08-27

Apple M3 Pro, Chrome 148, foreground window, 1728 CSS px wide at `devicePixelRatio` 2, WebGL2,
120 Hz display. `visibleAtStart: true`, no row spoiled. 6 s measurement window after 1.5 s warmup.

**One island**, so the rung is the whole scene:

| rung | fps mean | 1% low | p95 ms | max ms | TTFR ms | occupancy ms | heap MB | uploaded MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 250k | 119.0 | 59.2 | 10.3 | 41.3 | 480 | 8 | 21 | 4.5 |
| 1M | 118.8 | 55.5 | 10.3 | 33.1 | 218 | 13 | 37 | 18.0 |
| 2M | 115.6 | 30.4 | 10.4 | 41.9 | 138 | 21 | 67 | 36.0 |
| 3M | 113.4 | 24.1 | 10.3 | 56.5 | 200 | 44 | 102 | 54.0 |
| 4M | 111.2 | 18.3 | 10.3 | 82.2 | 258 | 62 | 137 | 72.0 |

**Three islands**, which is the Atlas workload: every island resident at once, its own transform,
its own buffers, one canvas, 9 draw calls.

| rung | total points | fps mean | 1% low | p95 ms | max ms | TTFR ms | heap MB | uploaded MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 250k | 0.75M | 120.0 | 96.0 | 10.2 | 10.5 | 155 | 21 | 13.5 |
| 1M | 3.00M | 98.5 | 29.3 | 24.8 | 41.1 | 99 | 39 | 54.0 |
| 2M | 6.00M | 67.2 | 19.8 | 41.5 | 51.8 | 125 | 69 | 108.0 |
| 3M | 9.00M | 58.8 | 11.9 | 50.1 | 89.6 | 157 | 121 | 162.0 |
| 4M | 12.00M | 49.8 | 11.5 | 65.2 | 90.3 | 165 | 137 | 216.0 |

### How to read that

- **The budget question is answered with room to spare.** ADR-0003's fixed budget is 1.5M for the
  scene. Three islands at 1M each is 3M resident points at 98.5 fps mean. The 60 fps line for
  *sustained mean* falls between 6M and 9M total points.
- **The mean is vsync-capped and the 1% low is the real signal.** A 120 Hz display flatters every
  mean in the single-island table; nothing there ever dropped below the refresh rate on average,
  even at 4M. The 1% low falling 59 to 18 across that same table is the honest degradation.
- **Time to first render is dominated by shader compilation, not by point count.** The 250k row's
  480 ms is the first program compile of the session; every later rung reuses it and lands between
  99 and 258 ms including a fetch of up to 216 MB from localhost. `.opm` decode is 0.1 ms at every
  rung, which is the container design working: three typed-array views, no per-point parse.
- **Heap is JS only and excludes VRAM.** 137 MB at 4M against 216 MB uploaded.
- **These are point-map numbers, not splat numbers.** Rung 3 is the guaranteed floor of the
  reconstruction ladder and the single-photo path is the primary experience, so it is the right
  thing to have measured first. It is not a measurement of the substrate PlayCanvas's six
  advantages are about, and it should not be quoted as one.

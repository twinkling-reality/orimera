# @orimera/scene-synth

Synthetic single-photo point maps for the ADR-0003 renderer bake-off.

Offline tool. Nothing that ships to a browser may import it, and
`.dependency-cruiser.cjs` enforces that.

```
pnpm synth --out ./fixtures                       # the whole ladder
pnpm synth --out ./fixtures --counts 1000000      # one rung
pnpm synth --out ./fixtures --seed 7 --ply        # a different world, plus a PLY to look at
```

Output is deterministic: same seed, same bytes, on any machine. Two renderer
bindings measured on two different point clouds have not been compared.

## What it produces, and why that shape

A procedural depth map, unprojected through a real pinhole camera. Not a cloud
of samples on surfaces, because the two are not the same workload:

| | Uniform sampling | Unprojected depth map |
| --- | --- | --- |
| World-space density | flat | falls off as 1/z² |
| Points per pixel | unrelated | exactly one |
| Behind an occluder | present | absent, because nothing was observed |
| Silhouettes | soft | genuine depth discontinuities |

A renderer's sort cost, overdraw, LoD clustering and frustum-cull behaviour all
depend on the spatial distribution. Measured against uniform noise, the bake-off
measures nothing.

Four kinds of honest hole are reproduced, each with its own confidence penalty:

1. **Unobserved.** Sky and everything outside the frustum. No point at all, and
   the largest hole by far.
2. **Occlusion boundaries.** A depth model interpolates across every silhouette
   and produces a stretched sheet; real pipelines discard it. What is left is a
   visible gap ringing each occluder.
3. **Grazing incidence.** Surfaces running nearly along the view ray get thinned
   and their survivors get very low confidence. Not thinned to zero: a monocular
   model returns a depth for every pixel, including ones it has no business being
   confident about, and deleting those hides the case per-point dissolve exists
   for.
4. **Low texture.** Water and blank walls degrade in blotches, not uniformly.

Per-point survival in the shipped scene ranges from about 5% (open water) to
about 95% (near deck), which is the non-uniform density that makes the fixture
worth measuring.

## The `.opm` container

One file, one fetch, zero parsing. GLB-shaped:

```
0..3    magic "OPM1"
4..7    uint32 LE  header byte length
8..     UTF-8 JSON header, space padded to a 16-byte boundary
        position  float32 x3   (12 B/point)   local frame, metres, +Y up, -Z forward
        color     uint8   x4   ( 4 B/point)   R, G, B, and ALPHA = CONFIDENCE
        segment   uint16  x1   ( 2 B/point)   semantic label, table in the header
```

18 bytes per point. Every section starts on a 16-byte boundary, so both engines
get zero-copy typed-array views.

**Alpha is confidence, not opacity.** Both engines support a normalised RGBA
vertex colour out of the box, so an unmodified renderer draws a low-confidence
point fainter with no shader work: "an unconfirmed candidate must look
unconfirmed" holds by default rather than by remembering to implement it. The
header says `"colorAlpha": "confidence"` so nobody has to infer it.

### Why not something standard

- **PLY.** Two engines, two loaders, two per-point JavaScript parses, and custom
  properties are exactly where those loaders diverge most. Parse time would land
  inside a number that is supposed to be about rendering. Emitted anyway with
  `--ply`, for MeshLab and SuperSplat, because being able to look at the fixture
  matters.
- **SOG.** ADR-0003 fixes SOG as the delivery format and that is right *there*,
  but SOG describes Gaussian splats. This is a point map: rung 3 on the
  reconstruction ladder, explicitly not splats. Encoding points as degenerate
  splats would misrepresent the rung and tilt the bake-off toward the splat path.
  When experiment X-1 produces a real splat, load real SOG alongside this.
- **glTF POINTS.** Viable. Rejected because `segment` and `confidence` become
  non-standard `_SEGMENT` / `_CONFIDENCE` attributes needing custom plumbing in
  both loaders, and PlayCanvas's glTF loader builds a full entity graph on the
  way in. More moving parts inside the measurement, no gain. `.opm` is
  deliberately GLB-shaped so moving later is a re-wrapping, not a rewrite.

### Loading it

```ts
const buffer = await (await fetch('harbour-1M.opm')).arrayBuffer();
const headerLength = new DataView(buffer).getUint32(4, true);
const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)));
const at = (name) => header.sections.find((s) => s.name === name);

const position = new Float32Array(buffer, at('position').byteOffset, header.pointCount * 3);
const color    = new Uint8Array(buffer,   at('color').byteOffset,    header.pointCount * 4);
const segment  = new Uint16Array(buffer,  at('segment').byteOffset,  header.pointCount);
```

three.js: `geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))`,
`'color'` with `normalized = true`, `'segment'` as a plain `BufferAttribute`.

PlayCanvas: build a `pc.VertexFormat` of `SEMANTIC_POSITION` (`TYPE_FLOAT32`, 3),
`SEMANTIC_COLOR` (`TYPE_UINT8`, 4, normalized), `SEMANTIC_ATTR0` (`TYPE_UINT16`, 1)
and hand each view to a `pc.VertexBuffer`.

Neither path touches a point individually on the CPU. That is the requirement.

## The island fixture

`harbour-scene.json` is three islands laid out by the real `atlas-core` layout
solver, with 18 anchors spanning the epistemic states the overlay must
distinguish: confirmed and user-provided, auto-provisional at high confidence,
proposed at low confidence, and capture-supported. If a binding renders all four
identically, that is a bake-off finding.

atlas-core's branded types erase completely at runtime, so
`JSON.parse(text) as AtlasScene` is sound. The one exception is
`layoutEntities`, which is a `Set` and serialises as an array; rehydrate with
`new Set(json.layoutEntities)`.

Measure both bindings with the anchor overlay live: manual projection into
pre-allocated DOM nodes, the focus solver running every frame, the emphasis
instance buffer, and the overlay caps of one focus label, six pinned callouts
and four edge chevrons. A binding that only draws points measures half the
frame budget.

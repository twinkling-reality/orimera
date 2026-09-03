/**
 * The point material's GLSL, kept in one file so it is reviewable as a shader rather than as
 * string fragments scattered through a builder.
 *
 * WebGL2 / GLSL ES 3.00. See `capabilities.ts` for why this binding is not on WebGPU.
 *
 * FOUR THINGS THIS SHADER IS RESPONSIBLE FOR, all of them product requirements rather than
 * effects:
 *
 * 1. PHYSICALLY HONEST POINT SIZE. A monocular point map has exactly one point per source pixel,
 *    so the patch a point stands for has world size `distance-from-the-capture-viewpoint x
 *    per-pixel angle`. Sizing from that rather than from a constant is what makes walking toward
 *    a surface look like approaching a photograph's own sampling instead of like a cloud of
 *    fixed-size dots, and it makes the far field honestly sparse: nothing invents coverage the
 *    camera did not have.
 *
 * 2. THE DISSOLVING BOUNDARY. Islands have no edges, walls or platform rims
 *    (interaction-model.md 1.4). The outer fifth of the footprint is a dissolve band where the
 *    island's own fog ramps up, and beyond the footprint the cloud decays exponentially into
 *    abstract space rather than stopping. `DISSOLVE_BAND_FRACTION` is passed in from atlas-core
 *    so the constant has one home.
 *
 * 3. PER-POINT SEMANTIC DISSOLVE, driven by real state. Two independent inputs: the
 *    reconstruction's own per-point confidence, which arrives in the colour buffer's alpha
 *    channel, and the entity graph's link state for the segment the point belongs to, which
 *    arrives through the 256x1 state texture. An unconfirmed candidate loses alpha AND scatters
 *    in space AND thins out, so it reads as unresolved rather than as merely dim.
 *
 * 4. STOCHASTIC ALPHA INSTEAD OF SORTED TRANSPARENCY. Every dissolve is resolved by discarding
 *    against a per-point stable hash, so the material is opaque, writes depth, needs no sort at
 *    any point count, and produces a genuinely particulate edge. The hash is stable per point
 *    and NOT re-seeded per frame: temporal dithering would be cheaper to look at in a still and
 *    is a comfort defect in motion, since Meta's locomotion guidance asks for minimal noisy
 *    high-frequency texture. So the grain holds still and the world dissolves by losing specific
 *    points, which is also what makes it read as missing data rather than as a fade.
 */

export const POINT_VERTEX_SHADER = /* glsl */ `
precision highp float;

in vec4 aColor;      // rgb albedo, ALPHA = per-point reconstruction confidence
in vec2 aTags;       // x semantic label id, indexes uSegmentState; y flags word, unread

uniform sampler2D uSegmentState;  // 256x1 RGBA8: emphasis, unconfirmed, provenance, flags

uniform vec3  uViewpointLocal;    // where the capture camera stood, island-local
uniform float uPixelAngle;        // 2*tan(fovY/2) / sourceImageHeight, radians per source pixel
uniform float uIslandScale;       // island presentation scale, atlas units per local unit
uniform float uViewportHeightPx;
uniform float uTanHalfFov;
uniform float uCoverage;          // >1 overlaps neighbouring points; kills pinholes on surfaces
uniform vec2  uPointSizeClampPx;

uniform float uFootprintRadius;   // local units
uniform float uDissolveBand;      // atlas-core DISSOLVE_BAND_FRACTION
uniform float uBoundaryFalloff;   // e-folding distance beyond the footprint, in footprint radii

uniform float uFogNear;
uniform float uFogFar;

uniform float uIslandEmphasis;
uniform float uConfidenceFloor;   // a zero-confidence point is faint, never invisible
uniform float uUnconfirmedScatter;
uniform float uTime;
uniform float uMotion;            // 0 under prefers-reduced-motion. Kills the ambient pulse.
uniform float uSuppressPeople;    // 1 = people are citations, not geometry. See below.

out vec4  vColor;
out float vAlpha;
out float vGrain;
out float vFog;
out float vCore;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx) * 2.0 - 1.0;
}

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
}

void main() {
  int seg = int(aTags.x + 0.5);
  vec4 state = texelFetch(uSegmentState, ivec2(seg, 0), 0);
  float emphasis    = state.r;
  float unconfirmed = state.g;
  float provenance  = state.b;
  int   flags       = int(state.a * 255.0 + 0.5);

  bool isPerson   = (flags & 1) != 0;
  bool isFocused  = (flags & 2) != 0;
  bool unresolved = (flags & 8) != 0;

  // PEOPLE ARE NOT BAKED INTO GEOMETRY. A person's points are dropped from the cloud entirely
  // and the anchor overlay draws a time-anchored presence marker instead: a sprite cropped from
  // the source, stamped with a timestamp, which opens the original photograph. Visibly a
  // citation. Reconstructing a person from a single monocular depth map would be inventing a
  // body from one view, which is exactly the claim this product must not make.
  if (isPerson && uSuppressPeople > 0.5) { cull(); return; }

  // "hidden" is emphasis exactly 0 and is reserved for content the user deleted
  // (interaction-model.md 7.3 rule 1). Everything else mutes toward a floor and stays visible,
  // because the world's shape has to survive a query for spatial memory to survive it.
  if (emphasis <= 0.002) { cull(); return; }

  float grain = hash13(position * 7.31 + float(seg));

  // Unconfirmed candidates scatter in space, not only in brightness. The displacement is scaled
  // by the point's own patch size, so a far point drifts further in world units and the same
  // amount on screen.
  float captureDist = max(0.05, distance(position, uViewpointLocal));
  // "patch" is a reserved word in GLSL ES 3.00 (tessellation), hence the suffix.
  float patchSize = captureDist * uPixelAngle;
  vec3 scattered = position + hash33(position * 3.7) * (unconfirmed * uUnconfirmedScatter * patchSize);

  vec4 world = modelMatrix * vec4(scattered, 1.0);
  vec4 mv = viewMatrix * world;
  float depth = max(0.001, -mv.z);
  gl_Position = projectionMatrix * mv;

  // 1. Physically honest point size.
  float worldPatch = patchSize * uIslandScale * uCoverage;
  float sizePx = uViewportHeightPx * worldPatch / (2.0 * depth * uTanHalfFov);
  sizePx *= isFocused ? 1.25 : 1.0;
  sizePx *= mix(1.0, 0.72, unconfirmed);
  gl_PointSize = clamp(sizePx, uPointSizeClampPx.x, uPointSizeClampPx.y);

  // NO ENERGY-PRESERVING ALPHA HERE, and the reason is worth stating because the opposite is the
  // usual reflex. sizePx is the screen size of ONE SOURCE PIXEL's patch. Below one pixel it means
  // several source pixels are landing in the same screen pixel, which is oversampling, not
  // sparsity, and the cloud already has all the coverage it claims. Dimming those points would
  // make a 4M island darker than the same surface at 250k, which is a lie in the other direction:
  // the world would look less certain the more evidence it had. Alpha is confidence and semantics
  // only; geometry never touches it.

  // 2. The dissolving boundary. Mirrors atlas-core dissolveBandParameter, then keeps going.
  float rLocal = length(scattered.xz);
  float bandStart = uFootprintRadius * (1.0 - uDissolveBand);
  float band = clamp((rLocal - bandStart) / max(0.0001, uFootprintRadius - bandStart), 0.0, 1.0);
  float beyond = max(0.0, rLocal - uFootprintRadius) / max(0.0001, uFootprintRadius);
  float edge = mix(1.0, 0.25, band * band) * exp(-beyond / max(0.0001, uBoundaryFalloff));

  // 3. Semantic state.
  float confidence = mix(uConfidenceFloor, 1.0, aColor.a);
  float semantic = mix(1.0, 0.28, unconfirmed);
  // NORMAL emphasis must map to FULL alpha. atlas-core's EMPHASIS_SCALAR.normal is 0.45, which
  // is the scale midpoint and not a dimming instruction: muted while a query is active,
  // normal otherwise. A world with no query active has to look solid, or the user reads the
  // resting state as uncertainty. So the ramp saturates at normal and only mutes below it,
  // which puts muted (0.12) near half alpha: visible, identifiable, walkable up to, and clearly
  // not the answer. Mute, do not hide.
  float emphasised = clamp(0.28 + emphasis * 1.6, 0.0, 1.0) * mix(0.55, 1.0, uIslandEmphasis);

  vFog = 1.0 - smoothstep(uFogNear, uFogFar, depth);
  vAlpha = confidence * semantic * emphasised * edge;

  // Provenance must be visually distinguishable wherever it appears. The tint is deliberately
  // small: it has to survive next to a photographic albedo without turning the world into a
  // legend. The overlay carries the explicit chip; this is the ambient half of the same fact.
  vec3 tint =
      provenance < 0.17 ? vec3(0.86, 0.90, 0.95)   // capture: neutral cool white
    : provenance < 0.50 ? vec3(0.72, 0.86, 1.00)   // inference: cool blue
    : provenance < 0.83 ? vec3(1.00, 0.90, 0.72)   // user: warm amber
                        : vec3(0.80, 1.00, 0.86);  // external web: green
  vec3 rgb = mix(aColor.rgb, aColor.rgb * tint, 0.35);

  // The ambient initiative channel: unresolved anchors take a slow cool pulse and no text.
  // 5.5 sets no period; 6 s sits inside the 4-6 s breathing band 3.2 specifies for stage 0.
  float pulse = unresolved ? (0.5 + 0.5 * sin(uTime * 1.047 + grain * 6.28318)) * uMotion : 0.0;
  rgb = mix(rgb, rgb * vec3(0.78, 0.92, 1.15), pulse * 0.5);
  if (isFocused) rgb *= 1.35;

  vColor = vec4(rgb, 1.0);
  vGrain = grain;
  // An unconfirmed point is also SOFTER: less core, more halo, so the silhouette is wispy.
  vCore = mix(0.55, 0.02, unconfirmed);
}
`;

export const POINT_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uFogColor;
uniform float uDitherFloor;

in vec4  vColor;
in float vAlpha;
in float vGrain;
in float vFog;
in float vCore;

out vec4 fragColor;

void main() {
  vec2 d2 = gl_PointCoord - 0.5;
  float d = length(d2) * 2.0;
  if (d > 1.0) discard;

  float soft = 1.0 - smoothstep(vCore, 1.0, d);
  float a = vAlpha * soft;

  // 4. Stochastic alpha. No blending, no sort, depth written. The point either exists this frame
  // or it does not, and which points survive is stable, so a dissolving island reads as missing
  // samples rather than as a cross-fade.
  if (a < mix(uDitherFloor, 1.0, vGrain)) discard;

  fragColor = vec4(mix(uFogColor, vColor.rgb, vFog), 1.0);
}
`;

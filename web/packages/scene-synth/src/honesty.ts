import type { Intrinsics } from './camera.js';
import { pixelRay } from './camera.js';
import { fbm3 } from './noise.js';
import type { Primitive, Segment } from './primitives.js';
import { hash2Unit } from './rng.js';
import type { DepthBuffers } from './raster.js';
import { MISS } from './raster.js';

/**
 * The honest holes.
 *
 * A real single-photo point map is incomplete in four specific, describable ways, and every one
 * of them changes the spatial distribution of the points that survive. Reproducing them is the
 * difference between a fixture that predicts renderer behaviour and one that does not.
 *
 *   1. NOTHING WAS OBSERVED. Sky, and everything outside the frustum. No point at all, and by far
 *      the largest hole. This is handled upstream: a ray that hits nothing writes nothing.
 *   2. OCCLUSION BOUNDARIES. At every silhouette the depth model interpolates across the cliff
 *      and produces a sheet of stretched points connecting foreground to background. Every real
 *      pipeline discards them. What is left is a visible gap ringing each occluder, which is the
 *      single most recognisable feature of a 2.5D shell.
 *   3. GRAZING INCIDENCE. Where a surface runs nearly along the view ray, one pixel covers metres
 *      of surface and the depth estimate is worthless. Points are thinned toward nothing.
 *   4. LOW TEXTURE. Open water, blank walls, flat sky-lit surfaces. Nothing to match on, so the
 *      estimate degrades in blotches rather than uniformly.
 *
 * Every drop is also recorded as a per-point CONFIDENCE, not just as an absence. That is what
 * lets per-point dissolve be driven by real state rather than by a shader told to look
 * mysterious: a surviving point near a carved edge is genuinely less trustworthy than one in the
 * middle of a well-observed wall, and it should look it.
 */

export interface HonestyParams {
  /** Relative depth step that counts as an occlusion boundary. 0.06 means a 6 percent jump. */
  readonly edgeRelativeStep: number;
  /** Carve radius in pixels at a reference width of 1400 px. Scaled with resolution. */
  readonly carveRadiusRef: number;
  /** Below this |N.V| the surface is considered edge-on and is thinned to nothing. */
  readonly grazingCosLo: number;
  /** Above this |N.V| there is no grazing penalty. */
  readonly grazingCosHi: number;
  /**
   * Keep probability at maximum grazing.
   *
   * NOT zero, deliberately. A monocular depth model returns a depth for every pixel, including
   * pixels where it has no business being confident: open water seen at two degrees of elevation
   * comes back as a plausible plane. The honest representation of that is a sparse scatter of
   * VERY LOW CONFIDENCE points, not an absence. Deleting them would hide the case the per-point
   * dissolve exists for.
   */
  readonly grazingKeepFloor: number;
  /** How aggressively low-texture segments blotch out. 0 disables. */
  readonly textureDropout: number;
  /** Range beyond which points start thinning, metres. */
  readonly rangeStart: number;
  /** Range over which thinning reaches full strength, metres. */
  readonly rangeSpan: number;
  /** Keep probability at full range thinning. */
  readonly rangeFloor: number;
}

export const DEFAULT_HONESTY: HonestyParams = Object.freeze({
  edgeRelativeStep: 0.055,
  carveRadiusRef: 3,
  grazingCosLo: 0.022,
  grazingCosHi: 0.30,
  grazingKeepFloor: 0.22,
  textureDropout: 0.68,
  rangeStart: 18,
  rangeSpan: 40,
  rangeFloor: 0.28,
});

export interface KeepMask {
  readonly keep: Uint8Array;
  /** 0..255. Rides in the colour buffer's alpha channel; see format/opm.ts. */
  readonly confidence: Uint8Array;
  /**
   * One byte per pixel, non-zero where a KEPT pixel had a four-neighbour carved at an occlusion
   * boundary. Rides in bit 0 of the tags flags channel; ADR-0010 D4.
   *
   * Computed here because this is where the carve mask exists. It is deliberately NOT "this
   * pixel has a missing neighbour": a neighbour that was a miss is a frustum or sky boundary and
   * a neighbour dropped by the grazing, texture or range dice is thin sampling, and a loader can
   * see both of those for itself from the lattice it reprojects. What it cannot see is that a
   * neighbour was REMOVED at a silhouette, which is a surface continuing with its rim taken off.
   *
   * Taken before `trimToExactly`, which zeroes further keep entries to hit an exact point count.
   * A pixel lost to that is lost to arithmetic rather than to a silhouette, so folding it in
   * would make the flag mean something the fixture's own honesty model does not.
   */
  readonly oneSided: Uint8Array;
  readonly keptCount: number;
  readonly stats: {
    readonly missed: number;
    readonly carved: number;
    readonly grazingDropped: number;
    readonly textureDropped: number;
    readonly rangeDropped: number;
  };
}

const smoothstep = (lo: number, hi: number, x: number): number => {
  if (hi <= lo) return x >= hi ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Separable max-dilation of a byte mask. Two O(n*r) passes rather than one O(n*r^2). */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let v = 0;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let xx = x0; xx <= x1 && v === 0; xx += 1) v = mask[row + xx]!;
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let v = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let yy = y0; yy <= y1 && v === 0; yy += 1) v = tmp[yy * width + x]!;
      out[y * width + x] = v;
    }
  }
  return out;
}

/**
 * Mark pixels on the FAR side of a depth cliff.
 *
 * Far side specifically: the stretched sheet a depth model produces belongs to the background,
 * and it is the background that loses its points. The foreground silhouette survives, which is
 * why an occluder still reads as a solid object with a hole behind it rather than a torn edge.
 */
function edgeMask(buf: DepthBuffers, relStep: number): Uint8Array {
  const { width, height, depth, prim } = buf;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (prim[i] === MISS) continue;
      const d = depth[i]!;
      let isFarSide = false;
      for (let a = 0; a < 4 && !isFarSide; a += 1) {
        const nx = x + (a === 0 ? -1 : a === 1 ? 1 : 0);
        const ny = y + (a === 2 ? -1 : a === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        // A neighbour that is a miss is a frustum or sky boundary, not an occlusion boundary.
        if (prim[j] === MISS) continue;
        if (depth[j]! < d * (1 - relStep)) isFarSide = true;
      }
      if (isFarSide) out[i] = 1;
    }
  }
  return out;
}

export function computeKeepMask(
  buf: DepthBuffers,
  k: Intrinsics,
  segments: readonly Segment[],
  prims: readonly Primitive[],
  eye: readonly [number, number, number],
  seed: number,
  params: HonestyParams = DEFAULT_HONESTY,
): KeepMask {
  const { width, height, depth, prim, normal } = buf;
  const n = width * height;
  const keep = new Uint8Array(n);
  const confidence = new Uint8Array(n);

  const carveRadius = Math.max(1, Math.round((params.carveRadiusRef * width) / 1400));
  const edges = edgeMask(buf, params.edgeRelativeStep);
  const carved = dilate(edges, width, height, carveRadius);
  const nearEdge = dilate(carved, width, height, carveRadius * 2);

  let missed = 0;
  let carvedCount = 0;
  let grazingDropped = 0;
  let textureDropped = 0;
  let rangeDropped = 0;
  let kept = 0;

  const [ox, oy, oz] = eye;

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const i = py * width + px;
      const p = prim[i]!;
      if (p === MISS) {
        missed += 1;
        continue;
      }
      if (carved[i] === 1) {
        carvedCount += 1;
        continue;
      }

      const d = depth[i]!;
      const { dx, dy } = pixelRay(k, px, py);
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const vx = dx * invLen;
      const vy = dy * invLen;
      const vz = -invLen;

      const nx = normal[i * 3]! / 127;
      const ny = normal[i * 3 + 1]! / 127;
      const nz = normal[i * 3 + 2]! / 127;
      const cosNV = Math.abs(nx * vx + ny * vy + nz * vz);
      // Two different numbers from one measurement: how many points survive, and how much any
      // surviving point is worth. Conflating them is what produces either a hole where a real
      // pipeline has bad data, or confident-looking garbage.
      const pGraze = smoothstep(params.grazingCosLo, params.grazingCosHi, cosNV);
      const pGrazeKeep = params.grazingKeepFloor + (1 - params.grazingKeepFloor) * pGraze;

      const seg = segments[prims[p]!.segment]!;
      const hx = ox + dx * d;
      const hy = oy + dy * d;
      const hz = oz - d;
      // Blotches, sampled in world space so they stay on the surface across resolutions.
      const blotch = fbm3(hx * 0.22, hy * 0.22, hz * 0.22, seed ^ 0x2f19, 3);
      const textureFloor = (1 - seg.texture) * params.textureDropout;
      const pTexture = blotch < textureFloor ? 0 : 1;
      const pTextureConf = seg.texture * 0.45 + 0.55;

      const rangeT = Math.max(0, (d - params.rangeStart) / params.rangeSpan);
      const pRange = Math.max(params.rangeFloor, 1 - Math.min(1, rangeT) * (1 - params.rangeFloor));

      const pKeep = pGrazeKeep * pTexture * pRange;
      const dice = hash2Unit(px, py, seed ^ 0x7a3b);

      if (dice >= pKeep) {
        // Attribute the drop to the factor that was actually decisive: the one whose own keep
        // probability the dice already exceeded. A drop can have more than one cause, so the
        // counters are attributed to the strongest and the caller is told they sum to the total
        // rather than partitioning it cleanly.
        if (pTexture === 0) textureDropped += 1;
        else if (dice >= pGrazeKeep) grazingDropped += 1;
        else rangeDropped += 1;
        continue;
      }

      keep[i] = 1;
      kept += 1;

      // Confidence is a property of the observation, not of the dice. A point that survived a
      // 30 percent keep probability is still a 30 percent trustworthy observation, and that is
      // exactly what the dissolve should show.
      const conf =
        pGraze *
        pTextureConf *
        (0.35 + 0.65 * pRange) *
        (nearEdge[i] === 1 ? 0.55 : 1);
      confidence[i] = Math.max(1, Math.min(255, Math.round(conf * 255)));
    }
  }

  // A kept pixel beside a carved one. Four-neighbour rather than eight, because that is the
  // lattice a load-time tangent frame is estimated on: the row and column neighbours are the two
  // half-extents and a diagonal contributes to neither.
  const oneSided = new Uint8Array(n);
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const i = py * width + px;
      if (keep[i] === 0) continue;
      const lost =
        (px > 0 && carved[i - 1] === 1) ||
        (px + 1 < width && carved[i + 1] === 1) ||
        (py > 0 && carved[i - width] === 1) ||
        (py + 1 < height && carved[i + width] === 1);
      if (lost) oneSided[i] = 1;
    }
  }

  return {
    keep,
    confidence,
    oneSided,
    keptCount: kept,
    stats: {
      missed,
      carved: carvedCount,
      grazingDropped,
      textureDropped,
      rangeDropped,
    },
  };
}

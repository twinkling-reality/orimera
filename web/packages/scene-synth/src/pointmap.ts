import type { Intrinsics } from './camera.js';
import { pixelRay } from './camera.js';
import { fbm3 } from './noise.js';
import type { Primitive, Segment } from './primitives.js';
import { hash2Unit } from './rng.js';
import type { DepthBuffers } from './raster.js';

/**
 * Unproject the surviving pixels into a point map.
 *
 * PER-POINT COLOUR and PER-POINT SEGMENT ID are both required by the brief so that per-point
 * semantic behaviour (dissolve, highlight) can be driven by real labels later rather than by a
 * shader guessing. The segment id is the primitive's semantic class, so it is a real label and
 * not a colour bucket.
 *
 * CONFIDENCE RIDES IN THE COLOUR ALPHA. That is a deliberate choice and not a saving of two
 * bytes: both candidate engines support a normalised RGBA vertex colour attribute out of the
 * box, so an unmodified renderer draws a low-confidence point fainter with no shader work at
 * all. "An unconfirmed candidate must LOOK unconfirmed" then holds by default rather than by
 * remembering to implement it. The header records `colorAlpha: "confidence"` so nobody has to
 * infer it, and under OPM/2 that field is an enum whose other value is `support`: this generator
 * writes a belief and the reconstruction path writes coverage, and a reader is now told which.
 *
 * THE SEGMENT ID SHARES AN ATTRIBUTE WITH A FLAGS WORD. ADR-0010 D3 widened the container's
 * two-byte segment channel to a four-byte `tags` section of two uint16 channels, because WebGPU
 * rejects a vertex stream whose arrayStride is not a multiple of 4 and the renderer binding was
 * paying a per-point CPU pass to widen it. Channel 1 carries bit 0 of D4, whether this point had
 * a neighbour carved at an occlusion boundary.
 */

/**
 * Bit 0 of a point's flags channel: a four-neighbour was carved at an occlusion boundary.
 *
 * Declared beside the type that carries the channel rather than in `format/opm.ts`, which is the
 * same placement `exulanica/reconstruction/pointmap.py` has and the arrangement that keeps the
 * dependency one-way: the writer reads the point map, and the point map knows nothing about the
 * container it will be written into.
 */
export const TAG_ONE_SIDED = 0x0001;

export interface PointMap {
  readonly count: number;
  /** 3 floats per point, LOCAL frame, metres, +Y up, -Z forward. */
  readonly position: Float32Array;
  /** 4 bytes per point: R, G, B, confidence. */
  readonly color: Uint8Array;
  /** 2 uint16 per point, interleaved: segment id then flags. */
  readonly tags: Uint16Array;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const SUN: readonly [number, number, number] = [0.4204, 0.7207, 0.5506];
const AMBIENT = 0.34;
const HAZE: readonly [number, number, number] = [0.55, 0.615, 0.70];
const HAZE_DENSITY = 0.0072;
const GAMMA = 1 / 2.2;

const toByte = (v: number): number =>
  Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, Math.min(1, v)), GAMMA) * 255)));

export function buildPointMap(
  buf: DepthBuffers,
  k: Intrinsics,
  keep: Uint8Array,
  confidence: Uint8Array,
  oneSided: Uint8Array,
  count: number,
  segments: readonly Segment[],
  prims: readonly Primitive[],
  eye: readonly [number, number, number],
  seed: number,
  depthJitter: number,
): PointMap {
  const position = new Float32Array(count * 3);
  const color = new Uint8Array(count * 4);
  const tags = new Uint16Array(count * 2);
  const [ox, oy, oz] = eye;

  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let w = 0;

  for (let py = 0; py < buf.height; py += 1) {
    for (let px = 0; px < buf.width; px += 1) {
      const i = py * buf.width + px;
      if (keep[i] === 0) continue;

      // High-frequency per-pixel depth jitter, applied last. Low-frequency bias was applied in
      // the raster pass, before edge detection, so it could not manufacture false silhouettes.
      const jitter = 1 + (hash2Unit(px, py, seed ^ 0x1c9d) - 0.5) * 2 * depthJitter;
      const d = buf.depth[i]! * jitter;

      const { dx, dy } = pixelRay(k, px, py);
      const hx = ox + dx * d;
      const hy = oy + dy * d;
      const hz = oz - d;

      position[w * 3] = hx;
      position[w * 3 + 1] = hy;
      position[w * 3 + 2] = hz;
      if (hx < min[0]) min[0] = hx;
      if (hy < min[1]) min[1] = hy;
      if (hz < min[2]) min[2] = hz;
      if (hx > max[0]) max[0] = hx;
      if (hy > max[1]) max[1] = hy;
      if (hz > max[2]) max[2] = hz;

      const seg = segments[prims[buf.prim[i]!]!.segment]!;
      tags[w * 2] = seg.id;
      tags[w * 2 + 1] = oneSided[i] === 1 ? TAG_ONE_SIDED : 0;

      const nx = buf.normal[i * 3]! / 127;
      const ny = buf.normal[i * 3 + 1]! / 127;
      const nz = buf.normal[i * 3 + 2]! / 127;
      const lambert = Math.max(0, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);
      const light = AMBIENT + (1 - AMBIENT) * lambert;

      // Surface texture, in world space so it does not swim between ladder rungs.
      const detail = fbm3(hx * 1.7, hy * 1.7, hz * 1.7, seed ^ 0x3ef1, 4);
      const mod = 1 + (detail - 0.5) * 0.95 * seg.texture;

      const fog = 1 - Math.exp(-d * HAZE_DENSITY);
      for (let c = 0; c < 3; c += 1) {
        const lit = seg.albedo[c]! * light * mod;
        color[w * 4 + c] = toByte(lit * (1 - fog) + HAZE[c]! * fog);
      }
      color[w * 4 + 3] = confidence[i]!;

      w += 1;
      if (w === count) break;
    }
    if (w === count) break;
  }

  if (w !== count) {
    throw new Error(`point map wrote ${w} points but the mask said ${count}`);
  }

  return { count, position, color, tags, min, max };
}

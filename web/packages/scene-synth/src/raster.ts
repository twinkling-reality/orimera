import type { Intrinsics } from './camera.js';
import { pixelRay } from './camera.js';
import { fbm3Signed } from './noise.js';
import type { Primitive } from './primitives.js';
import { intersect } from './primitives.js';

/**
 * Render the depth map.
 *
 * The generator produces a POINT MAP by unprojecting a depth map, rather than sampling surfaces
 * directly, because that is what a monocular metric depth model does and the difference is
 * visible in the output. Sampling surfaces gives uniform density on every surface. Unprojecting a
 * depth map gives density that falls off as 1/z^2 and gives exactly one point per valid pixel,
 * with the far side of every silhouette simply absent because the camera never saw it.
 *
 * That absence is not a defect to be papered over. Per the brief: do not invent geometry the
 * camera never saw, and the incompleteness IS the aesthetic.
 */

export const MISS = 0xffff;
const TILE = 64;

export interface DepthBuffers {
  readonly width: number;
  readonly height: number;
  /** Perpendicular depth in metres, or Infinity for a miss. */
  readonly depth: Float32Array;
  /** Primitive index, or MISS. */
  readonly prim: Uint16Array;
  /** Surface normal, 3 signed bytes per pixel, scaled by 127. */
  readonly normal: Int8Array;
  readonly hitCount: number;
}

interface Tiles {
  readonly cols: number;
  readonly rows: number;
  readonly lists: readonly (readonly number[])[];
}

/**
 * Bin primitives into screen tiles by their projected bounding sphere.
 *
 * Without this the cost is pixels times primitives, which at 6 megapixels and 25 primitives is
 * 150 million intersections. With it, most tiles test two or three primitives.
 */
function binPrimitives(
  prims: readonly Primitive[],
  k: Intrinsics,
  eye: readonly [number, number, number],
): Tiles {
  const cols = Math.ceil(k.width / TILE);
  const rows = Math.ceil(k.height / TILE);
  const lists: number[][] = Array.from({ length: cols * rows }, () => []);

  for (let i = 0; i < prims.length; i += 1) {
    const b = prims[i]!.bound;
    const x = b.x - eye[0];
    const y = b.y - eye[1];
    const d = eye[2] - b.z; // depth along -Z
    let x0 = 0;
    let y0 = 0;
    let x1 = cols - 1;
    let y1 = rows - 1;

    if (d - b.r > 0.05) {
      const rp = (k.focal * b.r) / (d - b.r);
      const px = k.cx + (k.focal * x) / d;
      const py = k.cy - (k.focal * y) / d;
      x0 = Math.max(0, Math.floor((px - rp) / TILE));
      x1 = Math.min(cols - 1, Math.floor((px + rp) / TILE));
      y0 = Math.max(0, Math.floor((py - rp) / TILE));
      y1 = Math.min(rows - 1, Math.floor((py + rp) / TILE));
    }

    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) lists[ty * cols + tx]!.push(i);
    }
  }

  return { cols, rows, lists };
}

export interface RasterOptions {
  readonly eye: readonly [number, number, number];
  readonly seed: number;
  /**
   * Low-frequency depth bias, as a fraction of depth squared.
   *
   * Monocular depth error grows superlinearly with range, and it is smooth rather than white:
   * flat surfaces come back gently bowed. This matters to a renderer because perfectly planar
   * point sets are an unrepresentatively easy case for sorting and for LoD clustering.
   */
  readonly depthBias: number;
  /** Per-pixel high-frequency jitter, as a fraction of depth. */
  readonly depthJitter: number;
}

export function rasterDepth(
  prims: readonly Primitive[],
  k: Intrinsics,
  opts: RasterOptions,
): DepthBuffers {
  const n = k.width * k.height;
  const depth = new Float32Array(n).fill(Infinity);
  const prim = new Uint16Array(n).fill(MISS);
  const normal = new Int8Array(n * 3);
  const tiles = binPrimitives(prims, k, opts.eye);
  const [ox, oy, oz] = opts.eye;
  let hitCount = 0;

  for (let py = 0; py < k.height; py += 1) {
    const trow = Math.floor(py / TILE) * tiles.cols;
    for (let px = 0; px < k.width; px += 1) {
      const list = tiles.lists[trow + Math.floor(px / TILE)]!;
      if (list.length === 0) continue;

      const { dx, dy } = pixelRay(k, px, py);
      let bestT = Infinity;
      let bestPrim = MISS;
      let bnx = 0;
      let bny = 0;
      let bnz = 0;

      for (const pi of list) {
        const h = intersect(prims[pi]!, ox, oy, oz, dx, dy);
        if (h === null || h.t >= bestT) continue;
        bestT = h.t;
        bestPrim = pi;
        bnx = h.nx;
        bny = h.ny;
        bnz = h.nz;
      }

      if (bestPrim === MISS) continue;

      // Low-frequency depth bias, sampled at the true hit point so it stays attached to the
      // surface across resolutions.
      const hx = ox + dx * bestT;
      const hy = oy + dy * bestT;
      const hz = oz - bestT;
      const bias =
        fbm3Signed(hx * 0.07, hy * 0.07, hz * 0.07, opts.seed ^ 0x51ed, 3) *
        opts.depthBias *
        bestT *
        bestT;

      const i = py * k.width + px;
      depth[i] = bestT + bias;
      prim[i] = bestPrim;
      normal[i * 3] = Math.max(-127, Math.min(127, Math.round(bnx * 127)));
      normal[i * 3 + 1] = Math.max(-127, Math.min(127, Math.round(bny * 127)));
      normal[i * 3 + 2] = Math.max(-127, Math.min(127, Math.round(bnz * 127)));
      hitCount += 1;
    }
  }

  return { width: k.width, height: k.height, depth, prim, normal, hitCount };
}

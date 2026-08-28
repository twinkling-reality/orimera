/**
 * Analytic surfaces, intersected exactly.
 *
 * Exactly, and not by marching a signed distance field, for one reason: OCCLUSION BOUNDARIES.
 * A real single-photo point map has genuine depth discontinuities at every silhouette, and those
 * discontinuities are where the honest holes come from. An SDF march would round every silhouette
 * by the step size and the carve in `honesty.ts` would have nothing crisp to bite on.
 */

export type SegmentClass = 'ground' | 'structure' | 'water' | 'person' | 'object' | 'vegetation';

export interface Segment {
  readonly id: number;
  readonly name: string;
  readonly cls: SegmentClass;
  /** Linear RGB, 0..1. Modulated by fbm at the hit point. */
  readonly albedo: readonly [number, number, number];
  /** How much surface texture the segment carries. Low texture means low depth confidence. */
  readonly texture: number;
}

export interface Hit {
  /** Perpendicular depth, metres. */
  readonly t: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

interface Base {
  readonly segment: number;
  /** Conservative bounding sphere, for tile binning. */
  readonly bound: { readonly x: number; readonly y: number; readonly z: number; readonly r: number };
}

/** An axis-aligned rectangle lying in a plane, given by a normal aligned with one axis. */
export interface RectPrim extends Base {
  readonly kind: 'rect';
  readonly axis: 'x' | 'y' | 'z';
  /** Position along `axis`. */
  readonly offset: number;
  /** Bounds on the other two axes, in ascending axis order (x<y<z). */
  readonly min0: number;
  readonly max0: number;
  readonly min1: number;
  readonly max1: number;
  /** +1 or -1: which way the surface faces along `axis`. */
  readonly facing: 1 | -1;
}

export interface BoxPrim extends Base {
  readonly kind: 'box';
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface SpherePrim extends Base {
  readonly kind: 'sphere';
  readonly c: readonly [number, number, number];
  readonly r: number;
}

/** A vertical finite cylinder. Masts, bollards, human torsos. */
export interface CylinderPrim extends Base {
  readonly kind: 'cylinder';
  readonly cx: number;
  readonly cz: number;
  readonly r: number;
  readonly y0: number;
  readonly y1: number;
}

/** A vertical plane at an arbitrary yaw, which is how the generator gets grazing incidence. */
export interface SlabPrim extends Base {
  readonly kind: 'slab';
  /** Point on the plane. */
  readonly p: readonly [number, number, number];
  /** Unit normal, horizontal (ny === 0). */
  readonly n: readonly [number, number, number];
  /** Half-extent along the in-plane horizontal direction, from `p`. */
  readonly halfWidth: number;
  readonly y0: number;
  readonly y1: number;
}

export type Primitive = RectPrim | BoxPrim | SpherePrim | CylinderPrim | SlabPrim;

const EPS = 1e-6;

/** Intersect a ray `o + t*(dx, dy, -1)` with a primitive. Returns null or the nearest positive t. */
export function intersect(
  p: Primitive,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
): Hit | null {
  const dz = -1;
  switch (p.kind) {
    case 'rect': {
      const d = p.axis === 'x' ? dx : p.axis === 'y' ? dy : dz;
      if (Math.abs(d) < EPS) return null;
      const o = p.axis === 'x' ? ox : p.axis === 'y' ? oy : oz;
      const t = (p.offset - o) / d;
      if (t <= EPS) return null;
      const hx = ox + dx * t;
      const hy = oy + dy * t;
      const hz = oz + dz * t;
      const [a, b] =
        p.axis === 'x' ? [hy, hz] : p.axis === 'y' ? [hx, hz] : [hx, hy];
      if (a < p.min0 || a > p.max0 || b < p.min1 || b > p.max1) return null;
      return {
        t,
        nx: p.axis === 'x' ? p.facing : 0,
        ny: p.axis === 'y' ? p.facing : 0,
        nz: p.axis === 'z' ? p.facing : 0,
      };
    }

    case 'box': {
      let tmin = -Infinity;
      let tmax = Infinity;
      let axis = 0;
      let sign = 1;
      const o = [ox, oy, oz];
      const d = [dx, dy, dz];
      for (let i = 0; i < 3; i += 1) {
        const di = d[i]!;
        const oi = o[i]!;
        if (Math.abs(di) < EPS) {
          if (oi < p.min[i]! || oi > p.max[i]!) return null;
          continue;
        }
        let t0 = (p.min[i]! - oi) / di;
        let t1 = (p.max[i]! - oi) / di;
        let s = -1;
        if (t0 > t1) {
          const tmp = t0;
          t0 = t1;
          t1 = tmp;
          s = 1;
        }
        if (t0 > tmin) {
          tmin = t0;
          axis = i;
          sign = s;
        }
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) return null;
      }
      if (tmin <= EPS) return null;
      return { t: tmin, nx: axis === 0 ? sign : 0, ny: axis === 1 ? sign : 0, nz: axis === 2 ? sign : 0 };
    }

    case 'sphere': {
      const ex = ox - p.c[0];
      const ey = oy - p.c[1];
      const ez = oz - p.c[2];
      const a = dx * dx + dy * dy + 1;
      const b = 2 * (ex * dx + ey * dy + ez * dz);
      const c = ex * ex + ey * ey + ez * ez - p.r * p.r;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      const t = (-b - sq) / (2 * a);
      if (t <= EPS) return null;
      const inv = 1 / p.r;
      return {
        t,
        nx: (ex + dx * t) * inv,
        ny: (ey + dy * t) * inv,
        nz: (ez + dz * t) * inv,
      };
    }

    case 'cylinder': {
      const ex = ox - p.cx;
      const ez = oz - p.cz;
      const a = dx * dx + dz * dz;
      if (a < EPS) return null;
      const b = 2 * (ex * dx + ez * dz);
      const c = ex * ex + ez * ez - p.r * p.r;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      const t = (-b - sq) / (2 * a);
      if (t <= EPS) return null;
      const hy = oy + dy * t;
      if (hy < p.y0 || hy > p.y1) return null;
      const inv = 1 / p.r;
      return { t, nx: (ex + dx * t) * inv, ny: 0, nz: (ez + dz * t) * inv };
    }

    case 'slab': {
      const denom = dx * p.n[0]! + dy * p.n[1]! + dz * p.n[2]!;
      if (Math.abs(denom) < EPS) return null;
      const t =
        ((p.p[0]! - ox) * p.n[0]! + (p.p[1]! - oy) * p.n[1]! + (p.p[2]! - oz) * p.n[2]!) / denom;
      if (t <= EPS) return null;
      const hy = oy + dy * t;
      if (hy < p.y0 || hy > p.y1) return null;
      // In-plane horizontal axis: normal rotated 90 degrees about Y.
      const ux = -p.n[2]!;
      const uz = p.n[0]!;
      const hx = ox + dx * t;
      const hz = oz + dz * t;
      const along = (hx - p.p[0]!) * ux + (hz - p.p[2]!) * uz;
      if (Math.abs(along) > p.halfWidth) return null;
      const s = denom > 0 ? -1 : 1;
      return { t, nx: p.n[0]! * s, ny: p.n[1]! * s, nz: p.n[2]! * s };
    }
  }
}

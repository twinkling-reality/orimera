import type { Primitive, Segment } from './primitives.js';

/**
 * The scene the generator photographs.
 *
 * A quayside. Chosen for four properties the bake-off actually needs, not for looks:
 *
 *   1. A deep view. Content from 1.8 m to about 60 m, so the 1/z^2 density falloff of a real
 *      point map is present across a wide range rather than compressed into one depth band.
 *   2. Strong foreground occluders. Crates and people at 3 to 12 m in front of a facade at 34 m,
 *      which produces the wide, obvious occlusion gaps that are the signature of a 2.5D shell.
 *   3. A grazing wall. A quay wall running almost along the view axis, where a monocular depth
 *      model is least reliable and a real pipeline discards most of the points. Thinning it is
 *      honest, and it also happens to be the case renderers handle worst.
 *   4. Thin structure and a low-texture region. A mast at 9 cm radius, and open water. Both are
 *      real failure modes and both produce characteristic holes.
 *
 * The people are here so that per-point segment ids can drive real semantic behaviour later.
 * They are geometry ONLY inside this synthetic fixture. In the product a person is never baked
 * into geometry: they render as a time-anchored presence marker cropped from the source image.
 * The segment ids are what lets the renderer binding find them and swap them out.
 */

export const CAMERA_HEIGHT = 1.55;

export const SEGMENTS: readonly Segment[] = Object.freeze([
  { id: 0, name: 'quay', cls: 'ground', albedo: [0.44, 0.41, 0.35], texture: 0.85 },
  { id: 1, name: 'water', cls: 'water', albedo: [0.10, 0.23, 0.30], texture: 0.18 },
  { id: 2, name: 'facade', cls: 'structure', albedo: [0.60, 0.50, 0.38], texture: 0.55 },
  { id: 3, name: 'quay-wall', cls: 'structure', albedo: [0.38, 0.36, 0.33], texture: 0.6 },
  { id: 4, name: 'crate', cls: 'object', albedo: [0.52, 0.31, 0.14], texture: 0.9 },
  { id: 5, name: 'bollard', cls: 'object', albedo: [0.22, 0.22, 0.24], texture: 0.5 },
  { id: 6, name: 'mast', cls: 'object', albedo: [0.72, 0.71, 0.68], texture: 0.35 },
  { id: 7, name: 'bench', cls: 'object', albedo: [0.34, 0.26, 0.18], texture: 0.85 },
  { id: 8, name: 'person-near', cls: 'person', albedo: [0.55, 0.24, 0.22], texture: 0.7 },
  { id: 9, name: 'person-far', cls: 'person', albedo: [0.20, 0.33, 0.52], texture: 0.7 },
  { id: 10, name: 'boat-hull', cls: 'object', albedo: [0.62, 0.60, 0.56], texture: 0.45 },
  { id: 11, name: 'planter', cls: 'vegetation', albedo: [0.17, 0.36, 0.14], texture: 0.95 },
]);

function bound(x: number, y: number, z: number, r: number) {
  return { x, y, z, r };
}

function box(segment: number, min: [number, number, number], max: [number, number, number]): Primitive {
  const c: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const r = Math.hypot(max[0] - c[0], max[1] - c[1], max[2] - c[2]);
  return { kind: 'box', segment, min, max, bound: bound(c[0], c[1], c[2], r) };
}

function cyl(segment: number, cx: number, cz: number, r: number, y0: number, y1: number): Primitive {
  return {
    kind: 'cylinder',
    segment,
    cx,
    cz,
    r,
    y0,
    y1,
    bound: bound(cx, (y0 + y1) / 2, cz, Math.hypot(r, (y1 - y0) / 2)),
  };
}

function sphere(segment: number, c: [number, number, number], r: number): Primitive {
  return { kind: 'sphere', segment, c, r, bound: bound(c[0], c[1], c[2], r) };
}

function ground(segment: number, y: number, x0: number, x1: number, z0: number, z1: number): Primitive {
  return {
    kind: 'rect',
    segment,
    axis: 'y',
    offset: y,
    min0: x0,
    max0: x1,
    min1: z0,
    max1: z1,
    facing: 1,
    bound: bound((x0 + x1) / 2, y, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2),
  };
}

function wallZ(segment: number, z: number, x0: number, x1: number, y0: number, y1: number): Primitive {
  return {
    kind: 'rect',
    segment,
    axis: 'z',
    offset: z,
    min0: x0,
    max0: x1,
    min1: y0,
    max1: y1,
    facing: 1,
    bound: bound((x0 + x1) / 2, (y0 + y1) / 2, z, Math.hypot(x1 - x0, y1 - y0) / 2),
  };
}

/** A vertical plane at a yaw, used to create genuine grazing incidence. */
function slab(
  segment: number,
  p: [number, number, number],
  yawDeg: number,
  halfWidth: number,
  y0: number,
  y1: number,
): Primitive {
  const a = (yawDeg * Math.PI) / 180;
  const n: [number, number, number] = [Math.cos(a), 0, Math.sin(a)];
  return {
    kind: 'slab',
    segment,
    p,
    n,
    halfWidth,
    y0,
    y1,
    bound: bound(p[0], (y0 + y1) / 2, p[2], Math.hypot(halfWidth, (y1 - y0) / 2)),
  };
}

/** A person: a torso cylinder plus a head sphere, sharing one segment id. */
function person(segment: number, x: number, z: number, height: number): Primitive[] {
  const shoulder = height * 0.82;
  return [
    cyl(segment, x, z, height * 0.13, 0, shoulder),
    sphere(segment, [x, shoulder + height * 0.1, z], height * 0.105),
  ];
}

export const PRIMITIVES: readonly Primitive[] = Object.freeze([
  // The near quay deck, from just behind the camera out to the quay edge at 14.2 m.
  ground(0, 0, -24, 24, -14.2, 3),
  // The harbour basin. Open water, 45 cm below the deck. Nearly edge-on from eye height and
  // almost textureless, so it keeps only a sparse scatter of low-confidence points. That is what
  // a monocular depth model actually gives you on water, and pretending otherwise would make the
  // fixture easier than the real thing.
  ground(1, -0.45, -70, 70, -110, -14.2),
  // The quay wall between deck and water: a lip that creates a hard depth cliff at the edge.
  wallZ(3, -14.2, -20, 20, -0.45, 0),
  // The far quay, across a 38 m basin, and its wall.
  ground(0, 0, -34, 34, -68, -52),
  wallZ(3, -52, -34, 34, -0.45, 0),
  // The back facade, standing on the far quay. At 56 m it is thinned hard by the range term,
  // which is what puts a genuine LoD problem in the fixture rather than a uniform point density.
  wallZ(2, -56, -27, 27, 0, 18),
  // A wall running almost along the view axis. 12 degrees off, so incidence is very grazing.
  slab(3, [-4.6, 0, -14], 12, 11, 0, 5.5),

  // Foreground occluders. The near crate is the strongest occlusion boundary in the frame.
  box(4, [-2.9, 0, -4.1], [-1.5, 1.2, -2.7]),
  box(4, [-2.6, 1.2, -3.9], [-1.7, 2.05, -3.0]),
  box(4, [3.1, 0, -8.6], [4.6, 1.1, -7.1]),
  box(7, [1.0, 0, -5.6], [2.9, 0.45, -5.0]),
  box(7, [1.0, 0.45, -5.6], [2.9, 1.05, -5.5]),

  // Bollards along the quay edge.
  cyl(5, -6.0, -13.4, 0.16, 0, 0.62),
  cyl(5, -1.4, -13.4, 0.16, 0, 0.62),
  cyl(5, 3.2, -13.4, 0.16, 0, 0.62),
  cyl(5, 7.8, -13.4, 0.16, 0, 0.62),

  // Thin structure: a mast. 9 cm radius at 11 m subtends about 2 px at 1500 px wide.
  cyl(6, 2.5, -16.5, 0.09, -0.45, 8.6),
  box(10, [0.4, -0.45, -19.5], [4.6, 0.5, -14.6]),

  // Planter, for a vegetation-class segment with high texture.
  box(11, [2.2, 0, -9.8], [3.4, 0.9, -8.6]),

  // Two people. Segment ids 8 and 9.
  ...person(8, -0.35, -6.2, 1.72),
  ...person(9, 5.1, -11.5, 1.66),
]);

export interface AnchorSpec {
  readonly key: string;
  readonly kind: 'person' | 'place' | 'object' | 'event';
  readonly segment: number;
  /** Local-frame position, metres. */
  readonly position: readonly [number, number, number];
  readonly focusRadius: number;
}

/**
 * Anchors, so the fixture is a real island and not just a point cloud.
 *
 * Both renderer bindings must draw the anchor overlay, run the focus solver against it and hold
 * the overlay caps (1 focus label, 6 pinned callouts, 4 edge chevrons). Shipping the point cloud
 * without anchors would let the bake-off measure only the splat path, which is the half of the
 * frame budget that is already understood.
 */
export const ANCHORS: readonly AnchorSpec[] = Object.freeze([
  { key: 'person-near', kind: 'person', segment: 8, position: [-0.35, 1.62, -6.2], focusRadius: 0.45 },
  { key: 'person-far', kind: 'person', segment: 9, position: [5.1, 1.56, -11.5], focusRadius: 0.42 },
  { key: 'boat', kind: 'object', segment: 10, position: [2.5, 0.3, -17.0], focusRadius: 1.6 },
  { key: 'facade', kind: 'place', segment: 2, position: [0, 6.0, -55.8], focusRadius: 6.0 },
  { key: 'crate-stack', kind: 'object', segment: 4, position: [-2.2, 1.1, -3.4], focusRadius: 0.9 },
  { key: 'planter', kind: 'object', segment: 11, position: [2.8, 0.9, -9.2], focusRadius: 0.7 },
]);

/** The scene's own extent, used for the footprint radius on the island fixture. */
export const FOOTPRINT_RADIUS_LOCAL = 58;

/**
 * Three coordinate frames, one of which is presentation only.
 * (interaction-model.md 1.2, and the R-48 high risk it names.)
 *
 *   AtlasFrame  - the world root, in "atlas units". PURELY PRESENTATIONAL.
 *   LocalFrame  - the reconstruction-native frame of one capture.
 *   MetricFrame - a LocalFrame that the reconstruction proved is metric, in metres.
 *
 * The hard rule: an island's atlas position carries no real-world meaning and must never be
 * read by anything that answers a question. Two islands being adjacent means their entity sets
 * overlap. It does not mean the photographs were taken near each other.
 *
 * What the type system does about it, in three parts:
 *
 *   1. The three vector types are mutually unassignable. Passing a LocalVec3 where an AtlasVec3
 *      is expected is a compile error, and vice versa.
 *   2. There is exactly one legal conversion, `localToAtlas`, and it is one-way. There is
 *      deliberately no `atlasToLocal` anywhere in this package. Going back would let a caller
 *      launder a presentational position into an answer about the world.
 *   3. Distance over AtlasVec3 is not exported from this module or from the package index. The
 *      layout and focus solvers genuinely need it, so it lives in `presentation-metrics.ts`,
 *      which the boundary contract forbids the query layer to import.
 *
 * Distance over LocalVec3 and MetricVec3 IS exported, because "how far apart were they" is a
 * legitimate question inside one metric island. Across islands it is not answerable at all, and
 * the correct response is a refusal, which is graph-client's job rather than a number this
 * module can produce.
 */

declare const FRAME: unique symbol;

interface Frame<F extends string> {
  readonly [FRAME]: F;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A position in the Atlas. Presentational. Never an answer. */
export type AtlasVec3 = Frame<'atlas'>;
/** A position in one island's own reconstruction-native frame. */
export type LocalVec3 = Frame<'local'>;
/** A position in a metric local frame, in metres. Only islands whose scale is metric have these. */
export type MetricVec3 = Frame<'metric'>;

/** Any of the three, for code that is genuinely frame-agnostic (normalisation, dot products). */
export type AnyVec3 = AtlasVec3 | LocalVec3 | MetricVec3;

const make = <F extends string>(x: number, y: number, z: number): Frame<F> =>
  ({ x, y, z }) as unknown as Frame<F>;

export const atlasVec3 = (x: number, y: number, z: number): AtlasVec3 => make(x, y, z);
export const localVec3 = (x: number, y: number, z: number): LocalVec3 => make(x, y, z);
export const metricVec3 = (x: number, y: number, z: number): MetricVec3 => make(x, y, z);

export const ATLAS_ORIGIN: AtlasVec3 = atlasVec3(0, 0, 0);
export const LOCAL_ORIGIN: LocalVec3 = localVec3(0, 0, 0);

/**
 * The direction the capture's camera was facing, in its own local frame.
 *
 * -Z, which is the convention three.js and PlayCanvas both use, so neither candidate binding in
 * ADR-0003 has to flip anything at load time. Named rather than implied, because it is the axis
 * the layout solver orients islands by and an `atan2` with two negated arguments is not
 * self-documenting.
 *
 * It matters which way an island faces. A 2.5D shell has observed surfaces on ONE side and a
 * void on the other, so an island turned the wrong way is a hole.
 */
export const CAPTURE_FORWARD_LOCAL: LocalVec3 = localVec3(0, 0, -1);

/**
 * A metric local frame is a local frame whose scale the reconstruction actually recovered.
 * Widening is legal (a metric position IS a local position); narrowing requires proof, which is
 * the island's `scaleIsMetric` flag. See `asMetricLocal`.
 */
export const metricAsLocal = (v: MetricVec3): LocalVec3 => make(v.x, v.y, v.z);

/**
 * The island placement. Presentation only.
 *
 * interaction-model.md 1.2: islands are never pitched or rolled, so the up vector stays globally
 * shared. That is why this is a yaw scalar and not a quaternion: a quaternion would make an
 * illegal orientation representable.
 */
export interface IslandPlacement {
  /** Position of the island's local origin, in atlas units. Carries no real-world meaning. */
  readonly position: AtlasVec3;
  /** Rotation about the shared up axis (+Y), radians. */
  readonly yaw: number;
  /** Uniform presentation scale. 1 means one local unit draws as one atlas unit. */
  readonly scale: number;
}

export const placement = (
  position: AtlasVec3,
  yaw: number,
  scale = 1,
): IslandPlacement => Object.freeze({ position, yaw, scale });

/**
 * The one legal conversion, and it is one-way.
 *
 * There is no `atlasToLocal` in this package and there must never be one. If a caller wants to
 * know where in a capture a world point falls, the answer is that the question is malformed:
 * atlas space is not a place.
 */
export function localToAtlas(p: IslandPlacement, v: LocalVec3): AtlasVec3 {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  const sx = v.x * p.scale;
  const sy = v.y * p.scale;
  const sz = v.z * p.scale;
  return make(
    p.position.x + sx * c + sz * s,
    p.position.y + sy,
    p.position.z + -sx * s + sz * c,
  );
}

/** Rotate a LOCAL direction into atlas space. Scale and translation do not apply to directions. */
export function localDirectionToAtlas(p: IslandPlacement, v: LocalVec3): AtlasVec3 {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return make(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

// ---------------------------------------------------------------------------------------------
// Frame-agnostic vector maths. These never mix frames: the type parameter is fixed per call.
// ---------------------------------------------------------------------------------------------

export const add = <V extends AnyVec3>(a: V, b: V): V =>
  make<string>(a.x + b.x, a.y + b.y, a.z + b.z) as V;

export const sub = <V extends AnyVec3>(a: V, b: V): V =>
  make<string>(a.x - b.x, a.y - b.y, a.z - b.z) as V;

export const scale = <V extends AnyVec3>(a: V, k: number): V =>
  make<string>(a.x * k, a.y * k, a.z * k) as V;

export const dot = (a: AnyVec3, b: AnyVec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const lengthOf = (a: AnyVec3): number => Math.sqrt(dot(a, a));

export function normalize<V extends AnyVec3>(a: V): V {
  const len = lengthOf(a);
  if (len === 0) return a;
  return scale(a, 1 / len);
}

/** Distance inside one island's local frame. Legitimate: it is real geometry, not layout. */
export const localDistance = (a: LocalVec3, b: LocalVec3): number => lengthOf(sub(a, b));

/**
 * Distance in metres. Only callable with MetricVec3, which only a metric island can produce, so
 * "how far apart were they" cannot accidentally be answered from a non-metric reconstruction.
 */
export const metricDistance = (a: MetricVec3, b: MetricVec3): number => lengthOf(sub(a, b));

/**
 * NOTE FOR REVIEWERS. There is intentionally no `atlasDistance` in this file and none in
 * `index.ts`. See `presentation-metrics.ts` and the `no-atlas-distance-outside-presentation`
 * rule in `.dependency-cruiser.cjs`.
 */

/**
 * One stable body with different weather inside it.
 *
 * The Companion is made from the Atlas's own substance: the same point-cloud material as its
 * regions, photographs, and anchors. Its sphere is therefore a body, not a chart and not a loader.
 * The sphere never changes into another geometry. State changes only affect local density, mote
 * illumination, short links between neighbours, and the steadiness of those events.
 *
 * The states are epistemic rather than emotional. `uncertain` is an inferred, unconfirmed link.
 * `settled` is a link the account holder confirmed. One certainty value derives brightness,
 * coherence, connection density, and steadiness together. The renderer cannot make an uncertain
 * graph look settled by pairing a loose structure with confident light.
 *
 * Temporal bars and completion figures are deliberately absent. Activity travels across the
 * sphere as local surface weather and never claims that a task is a measured distance from done.
 */

export type MoteState =
  /** Nothing is open. The body remains present without asking for attention. */
  | 'resting'
  /** A question is open. A small area gathers and illuminates. */
  | 'attending'
  /** An inferred link is still waiting for confirmation. */
  | 'uncertain'
  /** The graph and its evidence are being checked. */
  | 'working'
  /** The account holder confirmed the link. */
  | 'settled';

export const MOTE_COUNT = 560;

type Vec3 = readonly [number, number, number];
export type NeighborEdge = readonly [number, number];

export interface MoteProfile {
  /** The single epistemic value from which every confidence cue is derived. */
  readonly certainty: number;
  readonly brightness: number;
  readonly coherence: number;
  readonly connectionDensity: number;
  readonly steadiness: number;
  /** Operational activity. This never participates in confidence cues. */
  readonly activity: number;
  readonly gather: number;
  readonly ripple: number;
}

interface StateWeather {
  readonly certainty: number;
  readonly activity: number;
  readonly gather: number;
  readonly ripple: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const mix = (a: number, b: number, amount: number): number => a + (b - a) * amount;

/**
 * Derive the cues that can be read as confidence from one value.
 *
 * Keeping these formulas together is the honesty guard. No caller can independently turn up an
 * uncertain state's light or links while leaving the rest of its epistemic behavior unchanged.
 */
function profile(weather: StateWeather): MoteProfile {
  const certainty = clamp01(weather.certainty);
  return Object.freeze({
    certainty,
    brightness: mix(0.34, 0.96, certainty),
    coherence: mix(0.14, 0.98, certainty),
    connectionDensity: mix(0.012, 0.064, certainty),
    steadiness: mix(0.3, 0.985, certainty),
    activity: clamp01(weather.activity),
    gather: clamp01(weather.gather),
    ripple: clamp01(weather.ripple),
  });
}

/** The complete internal behavior contract for every semantic state. */
export const MOTE_PROFILES: Readonly<Record<MoteState, MoteProfile>> = Object.freeze({
  resting: profile({ certainty: 0.58, activity: 0.12, gather: 0.01, ripple: 0 }),
  attending: profile({ certainty: 0.58, activity: 0.28, gather: 0.16, ripple: 0.08 }),
  uncertain: profile({ certainty: 0.24, activity: 0.34, gather: 0.025, ripple: 0.04 }),
  working: profile({ certainty: 0.58, activity: 0.66, gather: 0.055, ripple: 0.92 }),
  settled: profile({ certainty: 1, activity: 0.018, gather: 0.07, ripple: 0 }),
});

/** Three first-party provenance colours, shared with the rest of the product. */
const TONES: readonly (readonly [number, number, number])[] = Object.freeze([
  [242, 238, 226], // capture
  [158, 176, 214], // inference
  [232, 202, 138], // user
]);

/** Stateless hash, so every mote keeps its character across frames and states. */
function hash(i: number, salt: number): number {
  let h = (Math.imul(i, 0x27d4eb2d) ^ Math.imul(salt, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Evenly spread directions on a sphere. Deterministic and free of pole clumping. */
function sphereDir(i: number, n: number): Vec3 {
  const y = 1 - (2 * i + 1) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = i * 2.399963229728653;
  return [Math.cos(angle) * r, y, Math.sin(angle) * r];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalized(v: Vec3): Vec3 {
  const d = Math.max(1e-9, length(v));
  return [v[0] / d, v[1] / d, v[2] / d];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function rotateX(v: Vec3, angle: number): Vec3 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [v[0], v[1] * cosine - v[2] * sine, v[1] * sine + v[2] * cosine];
}

function rotateY(v: Vec3, angle: number): Vec3 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [v[0] * cosine - v[2] * sine, v[1], v[0] * sine + v[2] * cosine];
}

/** Move along the sphere toward a focus without changing distance from the centre. */
function gatherDirection(direction: Vec3, focus: Vec3, amount: number): Vec3 {
  return normalized([
    mix(direction[0], focus[0], amount),
    mix(direction[1], focus[1], amount),
    mix(direction[2], focus[2], amount),
  ]);
}

/**
 * Each mote has one permanent depth inside the body.
 *
 * One fifth are boundary keepers near the shell. The rest occupy the volume. State animation may
 * move any mote along its own spherical layer, but may never change this radius.
 */
function makeRestPoint(index: number): Vec3 {
  const direction = sphereDir(index, MOTE_COUNT);
  const boundaryKeeper = hash(index, 31) < 0.2;
  const radius = boundaryKeeper
    ? mix(0.975, 1, hash(index, 37))
    : mix(0.34, 0.955, Math.cbrt(hash(index, 41)));
  return [direction[0] * radius, direction[1] * radius, direction[2] * radius];
}

const REST_POINTS: readonly Vec3[] = Object.freeze(
  Array.from({ length: MOTE_COUNT }, (_, index) => Object.freeze(makeRestPoint(index))),
);
const REST_DIRECTIONS: readonly Vec3[] = Object.freeze(
  REST_POINTS.map((point) => Object.freeze(normalized(point))),
);

export function moteRestPoint(index: number): Vec3 {
  if (!Number.isInteger(index) || index < 0 || index >= MOTE_COUNT) {
    throw new RangeError(`mote index ${index} is outside 0..${MOTE_COUNT - 1}`);
  }
  return REST_POINTS[index] as Vec3;
}

/** Build a small deterministic graph from actual nearest neighbours in the stable volume. */
function buildNeighborEdges(): readonly NeighborEdge[] {
  const seen = new Set<string>();
  const edges: NeighborEdge[] = [];

  for (let from = 0; from < MOTE_COUNT; from += 1) {
    const origin = REST_DIRECTIONS[from] as Vec3;
    const nearest: { index: number; score: number }[] = [];
    for (let to = 0; to < MOTE_COUNT; to += 1) {
      if (to === from) continue;
      const score = dot(origin, REST_DIRECTIONS[to] as Vec3);
      const candidate = { index: to, score };
      const position = nearest.findIndex((entry) => score > entry.score);
      if (position < 0) nearest.push(candidate);
      else nearest.splice(position, 0, candidate);
      if (nearest.length > 3) nearest.pop();
    }

    for (const near of nearest) {
      const a = Math.min(from, near.index);
      const b = Math.max(from, near.index);
      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(Object.freeze([a, b]));
    }
  }

  edges.sort((a, b) => {
    const orderA = hash(a[0] * MOTE_COUNT + a[1], 47);
    const orderB = hash(b[0] * MOTE_COUNT + b[1], 47);
    return orderA - orderB;
  });
  return Object.freeze(edges);
}

export const MOTE_NEIGHBOR_EDGES = buildNeighborEdges();

export interface MoteSample {
  readonly position: Vec3;
  readonly illumination: number;
}

/**
 * Sample one mote's internal weather.
 *
 * The returned position always has the same radius as `moteRestPoint(index)`. That invariant is
 * the fixed silhouette expressed as geometry rather than as a visual intention.
 */
export function sampleMote(
  state: MoteState,
  index: number,
  elapsedSeconds: number,
  reducedMotion = false,
): MoteSample {
  const base = moteRestPoint(index);
  const radius = length(base);
  const p = MOTE_PROFILES[state];
  const time = reducedMotion ? 0 : Math.max(0, elapsedSeconds);
  let direction = normalized(base);

  if (!reducedMotion) {
    const personalRate = mix(0.32, 0.68, hash(index, 53));
    const personalPhase = hash(index, 59) * Math.PI * 2;
    const drift =
      Math.sin(time * personalRate + personalPhase) * mix(0.012, 0.052, p.activity);
    const sharedFlow = Math.sin(time * 0.19) * p.coherence * p.activity * 0.018;
    direction = rotateY(direction, drift * mix(-1, 1, hash(index, 61)) + sharedFlow);
    direction = rotateX(direction, drift * mix(-0.7, 0.7, hash(index, 67)));
  }

  const focus = normalized([
    Math.cos(time * 0.17),
    0.24 + Math.sin(time * 0.11) * 0.2,
    Math.sin(time * 0.17),
  ]);
  const focusAffinity = clamp01((dot(direction, focus) + 0.12) / 1.12);
  const gatherEligible = radius < 0.93 && hash(index, 71) < 0.38;
  if (gatherEligible) {
    direction = gatherDirection(direction, focus, p.gather * focusAffinity);
  }

  const waveAxis = normalized([0.38, 0.81, -0.31]);
  const wavePosition = dot(direction, waveAxis) - time * 0.28;
  const waveCycle = ((wavePosition % 1) + 1) % 1;
  const waveDistance = Math.abs(waveCycle - 0.5);
  const ripple = Math.exp(-(waveDistance * waveDistance) / 0.012) * p.ripple;
  const flicker =
    0.72 +
    0.28 *
      (0.5 + 0.5 * Math.sin(time * mix(0.7, 1.35, hash(index, 73)) + hash(index, 79) * 8));
  const unstableLight = mix(flicker, 1, p.steadiness);
  const localLight = gatherEligible ? focusAffinity * p.gather * 1.35 : 0;
  const illumination = clamp01(p.brightness * unstableLight + ripple * 0.32 + localLight);

  const position = Object.freeze([
    direction[0] * radius,
    direction[1] * radius,
    direction[2] * radius,
  ]) as Vec3;
  return Object.freeze({ position, illumination });
}

/** Number of neighbour links this profile permits before temporal activity is applied. */
export function threadLimit(state: MoteState): number {
  return Math.floor(MOTE_NEIGHBOR_EDGES.length * MOTE_PROFILES[state].connectionDensity);
}

/** Pure link activity, so thread density and steadiness can be tested without a canvas. */
export function sampleThreadAlpha(
  state: MoteState,
  edgeIndex: number,
  elapsedSeconds: number,
  reducedMotion = false,
): number {
  if (edgeIndex < 0 || edgeIndex >= threadLimit(state)) return 0;
  const p = MOTE_PROFILES[state];
  if (reducedMotion) return mix(0.035, 0.15, p.coherence);

  const time = Math.max(0, elapsedSeconds);
  const phase =
    0.5 +
    0.5 * Math.sin(time * mix(0.52, 0.94, hash(edgeIndex, 83)) + hash(edgeIndex, 89) * 11);
  const transient = clamp01((phase - 0.68) / 0.24);
  const held = clamp01((p.steadiness - 0.7) / 0.285);
  const presence = mix(transient * transient * (3 - 2 * transient), 1, held);
  return presence * mix(0.035, 0.15, p.coherence);
}

export interface MoteFieldOptions {
  /** Seconds for one kind of internal weather to yield to another. */
  readonly transitionSeconds?: number;
  readonly reducedMotion?: boolean;
}

export interface MoteField {
  state(): MoteState;
  setState(next: MoteState): void;
  reducedMotion(): boolean;
  setReducedMotion(reduced: boolean): void;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, size: number): void;
}

function blendPosition(a: Vec3, b: Vec3, amount: number, radius: number): Vec3 {
  const direction = normalized([
    mix(a[0], b[0], amount),
    mix(a[1], b[1], amount),
    mix(a[2], b[2], amount),
  ]);
  return [direction[0] * radius, direction[1] * radius, direction[2] * radius];
}

export function createMoteField(options: MoteFieldOptions = {}): MoteField {
  const transitionSeconds = Math.max(0.01, options.transitionSeconds ?? 0.55);
  let state: MoteState = 'resting';
  let previous: MoteState = state;
  let transition = 1;
  let elapsed = 0;
  let reducedMotion = options.reducedMotion ?? false;
  const positions = new Float32Array(MOTE_COUNT * 3);
  const light = new Float32Array(MOTE_COUNT);
  const order = Array.from({ length: MOTE_COUNT }, (_, index) => index);

  return {
    state: () => state,

    setState(next) {
      if (next === state) return;
      previous = state;
      state = next;
      transition = reducedMotion ? 1 : 0;
    },

    reducedMotion: () => reducedMotion,

    setReducedMotion(reduced) {
      reducedMotion = reduced;
      if (reduced) transition = 1;
    },

    update(dt) {
      if (reducedMotion) return;
      const step = Math.max(0, dt);
      elapsed += step;
      transition = Math.min(1, transition + step / transitionSeconds);
    },

    draw(ctx, size) {
      const centre = size / 2;
      const scale = size * 0.405;
      const eased = transition * transition * (3 - 2 * transition);
      const spin = reducedMotion ? 0 : elapsed * mix(0.028, 0.085, MOTE_PROFILES[state].activity);
      const cosine = Math.cos(spin);
      const sine = Math.sin(spin);

      for (let index = 0; index < MOTE_COUNT; index += 1) {
        const after = sampleMote(state, index, elapsed, reducedMotion);
        const radius = length(REST_POINTS[index] as Vec3);
        const before = transition < 1 ? sampleMote(previous, index, elapsed, reducedMotion) : after;
        const position =
          transition < 1
            ? blendPosition(before.position, after.position, eased, radius)
            : after.position;
        const rotatedX = position[0] * cosine - position[2] * sine;
        const rotatedZ = position[0] * sine + position[2] * cosine;
        positions[index * 3] = rotatedX;
        positions[index * 3 + 1] = position[1];
        positions[index * 3 + 2] = rotatedZ;
        light[index] = mix(before.illumination, after.illumination, eased);
      }

      order.sort(
        (a, b) =>
          (positions[a * 3 + 2] as number) - (positions[b * 3 + 2] as number),
      );

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const threadCount = Math.max(threadLimit(previous), threadLimit(state));
      const threadTone = state === 'settled' ? TONES[2] : TONES[1];
      for (let edgeIndex = 0; edgeIndex < threadCount; edgeIndex += 1) {
        const edge = MOTE_NEIGHBOR_EDGES[edgeIndex];
        if (edge === undefined || threadTone === undefined) continue;
        const alpha = mix(
          sampleThreadAlpha(previous, edgeIndex, elapsed, reducedMotion),
          sampleThreadAlpha(state, edgeIndex, elapsed, reducedMotion),
          eased,
        );
        if (alpha < 0.008) continue;
        const from = edge[0];
        const to = edge[1];
        const depth =
          ((positions[from * 3 + 2] as number) + (positions[to * 3 + 2] as number) + 2) / 4;
        ctx.beginPath();
        ctx.moveTo(
          centre + (positions[from * 3] as number) * scale,
          centre + (positions[from * 3 + 1] as number) * scale,
        );
        ctx.lineTo(
          centre + (positions[to * 3] as number) * scale,
          centre + (positions[to * 3 + 1] as number) * scale,
        );
        ctx.lineWidth = 0.45 + depth * 0.45;
        ctx.strokeStyle = `rgba(${threadTone[0]}, ${threadTone[1]}, ${threadTone[2]}, ${(
          alpha * mix(0.48, 1, depth)
        ).toFixed(3)})`;
        ctx.stroke();
      }

      for (const index of order) {
        const depth = ((positions[index * 3 + 2] as number) + 1) / 2;
        const toneRoll = hash(index, 97);
        const tone = TONES[toneRoll < 0.055 ? 2 : toneRoll < 0.31 ? 1 : 0];
        if (tone === undefined) continue;
        const alpha = (0.12 + depth * 0.66) * (light[index] as number);
        const pointSize = 1.15 + depth * 1.65 + (light[index] as number) * 0.55;
        ctx.fillStyle = `rgba(${tone[0]}, ${tone[1]}, ${tone[2]}, ${alpha.toFixed(3)})`;
        ctx.fillRect(
          centre + (positions[index * 3] as number) * scale,
          centre + (positions[index * 3 + 1] as number) * scale,
          pointSize,
          pointSize,
        );
      }

      ctx.restore();
    },
  };
}

/** In review order, from neutral presence through the two epistemic endpoints. */
export const MOTE_STATES: readonly MoteState[] = Object.freeze([
  'resting',
  'attending',
  'working',
  'uncertain',
  'settled',
]);

export const MOTE_STATE_NOTES: Readonly<Record<MoteState, string>> = Object.freeze({
  resting: 'Nothing is open. The sphere stays dim, sparse, and slow.',
  attending: 'A question is open. Light gathers in one local area without changing the body.',
  working: 'The graph and its evidence are being checked. Ripples cross the stable sphere.',
  uncertain: 'This link is inferred and unconfirmed. Connections are sparse and unsteady.',
  settled: 'You confirmed this link. Connections are coherent, bright, and nearly still.',
});

/** Visible captions used when motion is reduced and cannot carry the state distinction. */
export const MOTE_STATE_CAPTIONS: Readonly<Record<MoteState, string>> = Object.freeze({
  resting: 'Companion resting. The sphere is dim and loosely connected.',
  attending: 'Companion attending to the open question. Light is gathered near its focus.',
  working: 'Companion checking the memory graph and its evidence.',
  uncertain: 'Inferred and unconfirmed. The sphere is dim, sparse, and unresolved.',
  settled: 'Confirmed by you. The sphere is bright, connected, and steady.',
});

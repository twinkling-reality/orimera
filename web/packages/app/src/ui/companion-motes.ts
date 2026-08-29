/**
 * One field of motes that takes different forms, and the form means something.
 *
 * The reference for this is the family of "thinking orb" loaders: one point substance that becomes
 * a sphere, a ring, a scatter, a spiral depending on what the agent is doing. Borrowing the
 * technique is easy. The part worth getting right is what the forms are ALLOWED to say.
 *
 * In a product whose whole discipline is proposing rather than asserting, a shape that changes
 * with state is not decoration, it is a claim about certainty, and it should therefore be wired to
 * certainty rather than to mood. So the axis this field runs on is coherence:
 *
 *   - **dispersed** means the system is not sure. An inferred link nobody has confirmed, a person
 *     matched at around 60% accuracy, a question that has not been answered. It looks unresolved
 *     because it IS unresolved.
 *   - **settled** means the account holder has said so. A confirmed identity is the one kind of
 *     certainty this product has, and it is the only state that earns a still, ordered lattice.
 *
 * That mapping is why this is not just a loader. A user can read what the system believes from
 * across the room without reading a word, and the reading is honest: the Companion cannot look
 * more certain than the graph is, because the same value drives both.
 *
 * No audio meaning anywhere. A pulsing bar or an equalizer would be the obvious "talking" form and
 * it is ruled out: this product has no audio and claims nothing about voices.
 */

export type MoteState =
  /** Nothing being asked. Whole, slow, dim. */
  | 'resting'
  /** A question is open and pointed at something. Gathers, brightens, orients. */
  | 'attending'
  /** Inferred and unconfirmed. Loose, wide, visibly unresolved. */
  | 'uncertain'
  /** Composing: reading the graph, resolving evidence. */
  | 'working'
  /** The account holder confirmed it. Ordered, still, certain. */
  | 'settled';

const COUNT = 560;

/** Provenance colours, the same four the rest of the product uses. */
const TONES: readonly (readonly [number, number, number])[] = Object.freeze([
  [242, 238, 226], // capture
  [158, 176, 214], // inference
  [232, 202, 138], // user
]);

/** Stateless hash, so every mote's character is fixed rather than reshuffling each frame. */
function hash(i: number, salt: number): number {
  let h = (Math.imul(i, 0x27d4eb2d) ^ Math.imul(salt, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Evenly spread directions on a sphere. Deterministic, no clumping. */
function sphereDir(i: number, n: number): [number, number, number] {
  const y = 1 - (2 * i + 1) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = i * 2.399963229728653;
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}

/**
 * Where a mote belongs in a given state, in unit space.
 *
 * Each of these is a whole form rather than a variation on one: morphing between a sphere and a
 * slightly smaller sphere reads as breathing, and the point here is that the states are legible as
 * DIFFERENT rather than as more or less of the same thing.
 */
function target(state: MoteState, i: number, n: number): [number, number, number] {
  const [dx, dy, dz] = sphereDir(i, n);
  switch (state) {
    case 'resting':
      return [dx * 0.62, dy * 0.62, dz * 0.62];

    case 'attending': {
      // Pulled toward the equator into a band. Orientation is the only way a form with no face
      // can point at something, so attending has a direction rather than merely a size.
      const flat = dy * 0.24;
      const spread = Math.sqrt(Math.max(0.0001, 1 - flat * flat));
      const a = i * 2.399963229728653;
      const r = 0.5 + hash(i, 3) * 0.05;
      return [Math.cos(a) * spread * r, flat * 0.9, Math.sin(a) * spread * r];
    }

    case 'uncertain': {
      // Wide, uneven, unresolved. The radius varies per mote rather than uniformly, so it reads
      // as a cloud that has not decided on a surface rather than as a bigger sphere.
      const r = 0.45 + hash(i, 7) * 0.62;
      return [dx * r, dy * r * 0.85, dz * r];
    }

    case 'working': {
      // A slow helix. Motion along a path reads as process in a way that a pulsing volume does
      // not, and it is the one form here that is unambiguously "still going".
      const t = i / n;
      const turns = 3.1;
      const a = t * Math.PI * 2 * turns;
      const r = 0.24 + t * 0.42;
      return [Math.cos(a) * r, (t - 0.5) * 1.05, Math.sin(a) * r];
    }

    case 'settled': {
      // A lattice. Order is the point: it is the only state the account holder has actually
      // confirmed, and it should look like the only thing here that stopped moving.
      const side = Math.ceil(Math.cbrt(n));
      const x = i % side;
      const y = Math.floor(i / side) % side;
      const z = Math.floor(i / (side * side));
      const step = 1.05 / (side - 1);
      return [x * step - 0.525, y * step - 0.525, z * step - 0.525];
    }
  }
}

export interface MoteFieldOptions {
  /** Seconds to travel most of the way to a new form. Slow enough to read as one thing moving. */
  readonly morphSeconds?: number;
}

export interface MoteField {
  state(): MoteState;
  setState(next: MoteState): void;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, size: number): void;
}

export function createMoteField(options: MoteFieldOptions = {}): MoteField {
  const morphSeconds = options.morphSeconds ?? 0.85;
  const current = new Float32Array(COUNT * 3);
  const from = new Float32Array(COUNT * 3);
  const to = new Float32Array(COUNT * 3);
  let state: MoteState = 'resting';
  let morph = 1;
  let spin = 0;
  let elapsed = 0;

  const write = (buf: Float32Array, s: MoteState): void => {
    for (let i = 0; i < COUNT; i += 1) {
      const [x, y, z] = target(s, i, COUNT);
      buf[i * 3] = x;
      buf[i * 3 + 1] = y;
      buf[i * 3 + 2] = z;
    }
  };
  write(current, state);
  write(from, state);
  write(to, state);

  return {
    state: () => state,

    setState(next) {
      if (next === state) return;
      // Morph from wherever the motes ACTUALLY are, not from the previous form's rest positions.
      // Interrupting a morph half way and restarting from the old target would make the field
      // jump backwards before setting off again.
      from.set(current);
      state = next;
      write(to, next);
      morph = 0;
    },

    update(dt) {
      elapsed += dt;
      // Slower while settled: a confirmed fact should look like it has stopped needing attention.
      spin += dt * (state === 'settled' ? 0.04 : state === 'working' ? 0.55 : 0.16);
      if (morph >= 1) return;
      morph = Math.min(1, morph + dt / morphSeconds);
      // Smoothstep, so a form arrives rather than stopping dead.
      const e = morph * morph * (3 - 2 * morph);
      for (let k = 0; k < current.length; k += 1) {
        const a = from[k] as number;
        const b = to[k] as number;
        current[k] = a + (b - a) * e;
      }
    },

    draw(ctx, size) {
      const c = size / 2;
      const scale = size * 0.42;
      const cs = Math.cos(spin);
      const sn = Math.sin(spin);
      // Brighter and denser as the form becomes more certain. The same number that decides the
      // shape decides the light, so the two can never disagree.
      const certainty = state === 'settled' ? 1 : state === 'uncertain' ? 0.42 : 0.72;

      for (let i = 0; i < COUNT; i += 1) {
        const x = current[i * 3] as number;
        const y = current[i * 3 + 1] as number;
        const z = current[i * 3 + 2] as number;
        // A small per-mote drift, always. A field that is perfectly still reads as a rendered
        // image rather than as something present, except when settled, where stillness is the
        // message and the drift is nearly switched off.
        const jitter = state === 'settled' ? 0.002 : 0.012;
        const wob = Math.sin(elapsed * 1.3 + i * 0.021) * jitter;
        const rx = (x + wob) * cs - z * sn;
        const rz = (x + wob) * sn + z * cs;
        const px = c + rx * scale;
        const py = c + (y + wob) * scale;
        const depth = (rz + 1) / 2;
        const alpha = (0.12 + depth * 0.62) * certainty;
        const tone = TONES[hash(i, 11) < 0.06 ? 2 : hash(i, 13) < 0.3 ? 1 : 0] as readonly [
          number,
          number,
          number,
        ];
        const s = 1.5 + depth * 1.4;
        ctx.fillStyle = `rgba(${tone[0]}, ${tone[1]}, ${tone[2]}, ${alpha.toFixed(3)})`;
        ctx.fillRect(px, py, s, s);
      }
    },
  };
}

/** In review order, so cycling walks from least to most certain. */
export const MOTE_STATES: readonly MoteState[] = Object.freeze([
  'resting',
  'attending',
  'working',
  'uncertain',
  'settled',
]);

export const MOTE_STATE_NOTES: Readonly<Record<MoteState, string>> = Object.freeze({
  resting: 'Nothing open. Whole, slow, dim.',
  attending: 'A question is open and pointed at something. Gathers into a band and brightens.',
  working: 'Reading the graph and resolving evidence. The one form that is plainly still going.',
  uncertain: 'Inferred and unconfirmed. Loose and wide, because it genuinely is unresolved.',
  settled: 'You confirmed it. Ordered and nearly still: the only certainty this product has.',
});

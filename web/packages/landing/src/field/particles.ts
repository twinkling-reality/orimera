/**
 * One particle field, for the whole session.
 *
 * This is the 2D echo of interaction-model.md 1.1: "There is exactly one scene graph, one camera
 * and one render loop for the entire lifetime of a session, from the landing page through to any
 * region interior. There is no scene loading, no 'enter' and no 'return'."
 *
 * The landing composition, the entrance transition and the unformed Atlas are the same particles
 * holding a different figure. Nothing is destroyed and nothing is recreated, which is why the
 * entrance reads as movement rather than as a page swap: the material in front of you is the
 * material that was in front of you a moment ago.
 */

import { KIND, type Figure } from './figure.js';
import { mulberry32 } from './rng.js';

export interface FieldParams {
  /** Particle count. Held constant for the session: this is the material, not a budget. */
  readonly count: number;
  /** Read from `prefers-reduced-motion`. Under reduced motion nothing integrates at all. */
  readonly reducedMotion: boolean;
}

const SPRING = 7.5;
const DAMPING = 2 * Math.sqrt(SPRING) * 1.02;
/** Longest a particle waits before its spring engages during a morph, in seconds. */
const MAX_STAGGER = 0.5;

export class ParticleField {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly kind: Uint8Array;
  /** Per-particle phase, so breathing and dissolve never fall into step across the field. */
  readonly phase: Float32Array;

  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly tx: Float32Array;
  private readonly ty: Float32Array;
  private readonly delay: Float32Array;
  /** 0 for a particle with no target in the current figure: it drifts as between-space dust. */
  private readonly bound: Uint8Array;

  private morphElapsed = 0;
  private reduced: boolean;

  constructor(params: FieldParams) {
    this.count = params.count;
    this.reduced = params.reducedMotion;
    const n = params.count;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.ty = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.phase = new Float32Array(n);
    this.delay = new Float32Array(n);
    this.bound = new Uint8Array(n);

    const rand = mulberry32(0x5eed11);
    for (let i = 0; i < n; i += 1) {
      // Start scattered wide, so the first morph reads as the field gathering into the Companion
      // rather than as a shape that was already there.
      this.x[i] = (rand() - 0.5) * 3.2;
      this.y[i] = (rand() - 0.5) * 2.6;
      this.phase[i] = rand() * Math.PI * 2;
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) this.snapToTargets();
  }

  /**
   * Adopt a new figure.
   *
   * Targets are assigned by index, which keeps the mapping stable between related figures and
   * stops a morph from shuffling material that did not need to move. The stagger is by radius:
   * outer particles release first, so a figure unspools from its edge inward instead of
   * collapsing all at once.
   */
  morphTo(figure: Figure): void {
    const n = this.count;
    for (let i = 0; i < n; i += 1) {
      if (i < figure.count) {
        this.tx[i] = figure.xy[i * 2] ?? 0;
        this.ty[i] = figure.xy[i * 2 + 1] ?? 0;
        this.kind[i] = figure.kind[i] ?? KIND.MOTE;
        this.bound[i] = 1;
      } else {
        this.kind[i] = KIND.MOTE;
        this.bound[i] = 0;
      }
      const px = this.x[i] ?? 0;
      const py = this.y[i] ?? 0;
      const r = Math.min(1, Math.hypot(px, py) / 1.4);
      this.delay[i] = (1 - r) * MAX_STAGGER;
    }
    this.morphElapsed = 0;
    if (this.reduced) this.snapToTargets();
  }

  /**
   * An outward impulse, used once: at the moment the entrance transition begins.
   *
   * It is what turns a cross-fade into a movement. The Companion's rings are pushed outward past
   * the viewer while the Atlas figure gathers underneath, so the eye reads forward travel through
   * dissolving material rather than one image replacing another.
   */
  impulse(strength: number): void {
    if (this.reduced) return;
    for (let i = 0; i < this.count; i += 1) {
      const px = this.x[i] ?? 0;
      const py = this.y[i] ?? 0;
      const d = Math.max(0.08, Math.hypot(px, py));
      this.vx[i] = (this.vx[i] ?? 0) + (px / d) * strength;
      this.vy[i] = (this.vy[i] ?? 0) + (py / d) * strength;
    }
  }

  /**
   * @param dt seconds since the last frame, already clamped by the caller
   * @param now seconds since start, for breathing phase
   * @param breathe amplitude of the non-advancing breathing motion, in units. Zero when the
   *   formation stream is frozen, which is what makes "the visual freezes" (8.4) literal.
   */
  step(dt: number, now: number, breathe: number): void {
    if (this.reduced) return;
    this.morphElapsed += dt;
    const n = this.count;

    for (let i = 0; i < n; i += 1) {
      let vx = this.vx[i] ?? 0;
      let vy = this.vy[i] ?? 0;
      const px = this.x[i] ?? 0;
      const py = this.y[i] ?? 0;

      if (this.bound[i] === 1 && this.morphElapsed >= (this.delay[i] ?? 0)) {
        const ph = this.phase[i] ?? 0;
        // Breathing is applied to the TARGET, not to the drawn position, so a particle that is
        // still travelling is not fighting two motions at once.
        const bx = Math.cos(ph + now * 0.7) * breathe;
        const by = Math.sin(ph * 1.3 + now * 0.55) * breathe;
        const ax = ((this.tx[i] ?? 0) + bx - px) * SPRING - vx * DAMPING;
        const ay = ((this.ty[i] ?? 0) + by - py) * SPRING - vy * DAMPING;
        vx += ax * dt;
        vy += ay * dt;
      } else {
        // Between-space dust. Low frequency and sparse, per the comfort requirement in
        // interaction-model.md 1.4: large soft gradients, no high-contrast movement.
        vx += Math.sin(py * 1.7 + now * 0.11) * 0.02 * dt;
        vy += Math.cos(px * 1.9 - now * 0.09) * 0.02 * dt;
        vx *= 1 - 0.35 * dt;
        vy *= 1 - 0.35 * dt;
      }

      let nx = px + vx * dt;
      let ny = py + vy * dt;

      // Wrap the dust rather than letting the field thin out over a long session.
      if (this.bound[i] === 0) {
        if (nx > 1.9) nx -= 3.8;
        else if (nx < -1.9) nx += 3.8;
        if (ny > 1.5) ny -= 3.0;
        else if (ny < -1.5) ny += 3.0;
      }

      this.x[i] = nx;
      this.y[i] = ny;
      this.vx[i] = vx;
      this.vy[i] = vy;
    }
  }

  private snapToTargets(): void {
    for (let i = 0; i < this.count; i += 1) {
      if (this.bound[i] === 1) {
        this.x[i] = this.tx[i] ?? 0;
        this.y[i] = this.ty[i] ?? 0;
      }
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
  }
}

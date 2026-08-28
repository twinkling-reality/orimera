/**
 * The atmosphere: one field, one renderer, one loop, for the whole session.
 *
 * This is where "the transition into the Atlas is continuous" is actually implemented. There is
 * no second canvas, no route change and no unmount. Entering the Atlas animates three numbers
 * (ground, zoom, vertical offset) and hands the field a different figure. The particles in front
 * of the user during the landing composition are the same particles in front of them afterwards.
 */

import type { FormationMotion, FormationVisual } from './formation/index.js';
import { companionFigure, formationFigure, unformedAtlasFigure } from './field/figures.js';
import { ParticleField } from './field/particles.js';
import { FieldRenderer } from './field/renderer.js';
import type { Env } from './env.js';
import { particleCount } from './env.js';

export type Composition =
  | { readonly kind: 'companion' }
  | { readonly kind: 'unformed-atlas' }
  | { readonly kind: 'formation'; readonly visual: FormationVisual };

/**
 * Breathing amplitude per motion state, in units.
 *
 * `frozen` and `stopped` are zero and the loop additionally stops integrating, so "the visual
 * freezes rather than continuing to animate optimistically" (interaction-model.md 8.4) is
 * literally true rather than approximately true.
 */
const BREATHE: Readonly<Record<FormationMotion, number>> = Object.freeze({
  advance: 0.004,
  breathe: 0.017,
  frozen: 0,
  settled: 0.005,
  stopped: 0,
});

/**
 * The landing composition sits to the right of the text column and a little above centre. The
 * Atlas composition is centred, so entering also brings the field to the middle of the frame:
 * the move inward is a move to the centre of the view as well as a change of ground.
 */
const LANDING_PAN_X = 0.48;
const LANDING_PAN_Y = -0.07;
/**
 * The Atlas composition sits right of the formation console rather than dead centre, because the
 * console is the left column in that view exactly as the headline is on the landing page. The
 * field stays beside the words in both, which is what makes the move read as one continuous
 * space rather than as two layouts.
 */
const ATLAS_PAN_X = 0.36;
const ATLAS_PAN_Y = 0.06;

interface Tween {
  from: number;
  to: number;
  started: number;
  duration: number;
}

export class Atmosphere {
  private readonly field: ParticleField;
  private readonly renderer: FieldRenderer;
  private raf = 0;
  private last = 0;
  private now = 0;
  private compositionKey = '';
  private motion: FormationMotion = 'breathe';
  private frozen = false;
  private reduced: boolean;

  private theme: Tween;
  private zoom: Tween;
  private panY: Tween;
  private panX: Tween;
  private opacity: Tween;

  constructor(canvas: HTMLCanvasElement, env: Env) {
    this.reduced = env.reducedMotion;
    this.field = new ParticleField({ count: particleCount(env.reducedMotion), reducedMotion: env.reducedMotion });
    this.renderer = new FieldRenderer(canvas);
    this.theme = still(0);
    this.zoom = still(1);
    this.panY = still(LANDING_PAN_Y);
    this.panX = still(LANDING_PAN_X);
    this.opacity = still(1);
    this.resize(env.dpr);
    this.setComposition({ kind: 'companion' });
  }

  start(): void {
    if (this.raf !== 0) return;
    this.last = performance.now();
    const loop = (t: number): void => {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      // A frozen stream advances neither the integrator nor the phase clock, so nothing on
      // screen can imply that work is still happening.
      if (!this.frozen) {
        this.now += dt;
        this.field.step(dt, this.now, BREATHE[this.motion]);
      }
      this.renderer.render(this.field, {
        theme: this.value(this.theme, t),
        zoom: this.value(this.zoom, t),
        panY: this.value(this.panY, t),
        panX: this.value(this.panX, t),
        opacity: this.value(this.opacity, t),
        now: this.now,
        reducedMotion: this.reduced,
      });
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resize(dpr: number): void {
    this.renderer.resize(window.innerWidth, window.innerHeight, dpr);
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    this.field.setReducedMotion(reduced);
  }

  /**
   * Adopt a composition.
   *
   * Keyed, and a repeat of the same key is a no-op. That is a correctness property rather than an
   * optimization: the formation figure may only change when the data behind it changed, so a
   * render loop can never nudge the world forward on its own.
   */
  setComposition(c: Composition): void {
    const key = compositionKey(c);
    if (key === this.compositionKey) return;
    this.compositionKey = key;
    const n = this.field.count;
    if (c.kind !== 'formation') {
      // Leaving a formation clears its motion. Without this, a capture whose stream was lost
      // would leave the field frozen behind the landing page, which would be a true statement
      // about a capture nobody is looking at any more and a broken atmosphere for everybody.
      this.motion = 'breathe';
      this.frozen = false;
    }
    if (c.kind === 'companion') this.field.morphTo(companionFigure(n));
    else if (c.kind === 'unformed-atlas') this.field.morphTo(unformedAtlasFigure(n));
    else {
      this.motion = c.visual.motion;
      this.frozen = c.visual.motion === 'frozen';
      this.field.morphTo(formationFigure(n, c.visual));
    }
  }

  setMotion(motion: FormationMotion): void {
    this.motion = motion;
    this.frozen = motion === 'frozen';
  }

  /**
   * The entrance: ground, dolly, and an outward impulse through the dissolving Companion.
   *
   * Under reduced motion this is a 260 ms opacity cross-fade with the ground and the figure
   * swapped instantly. That is the "genuinely calm alternative" rather than a frozen layout: the
   * page still arrives somewhere, it simply does not travel there. The information the movement
   * carried is restated as an arrival caption by the caller, which is the rule in
   * interaction-model.md section 9.
   */
  enterAtlas(): number {
    if (this.reduced) {
      this.setComposition({ kind: 'unformed-atlas' });
      this.theme = still(1);
      this.zoom = still(1);
      this.panY = still(ATLAS_PAN_Y);
      this.panX = still(ATLAS_PAN_X);
      this.opacity = tween(0.15, 1, 260);
      return 260;
    }
    this.field.impulse(0.55);
    this.setComposition({ kind: 'unformed-atlas' });
    this.theme = tween(0, 1, 1500);
    this.zoom = tween(1, 1.16, 700);
    window.setTimeout(() => {
      this.zoom = tween(1.16, 1, 1100);
    }, 700);
    this.panY = tween(LANDING_PAN_Y, ATLAS_PAN_Y, 1500);
    this.panX = tween(LANDING_PAN_X, ATLAS_PAN_X, 1500);
    return 1600;
  }

  /** The reverse, so that leaving is the same move run backwards rather than a second design. */
  returnToLanding(): number {
    if (this.reduced) {
      this.setComposition({ kind: 'companion' });
      this.theme = still(0);
      this.zoom = still(1);
      this.panY = still(LANDING_PAN_Y);
      this.panX = still(LANDING_PAN_X);
      this.opacity = tween(0.15, 1, 260);
      return 260;
    }
    this.setComposition({ kind: 'companion' });
    this.theme = tween(1, 0, 1200);
    this.zoom = tween(1, 0.94, 500);
    window.setTimeout(() => {
      this.zoom = tween(0.94, 1, 900);
    }, 500);
    this.panY = tween(ATLAS_PAN_Y, LANDING_PAN_Y, 1200);
    this.panX = tween(ATLAS_PAN_X, LANDING_PAN_X, 1200);
    return 1300;
  }

  private value(t: Tween, at: number): number {
    if (t.duration <= 0) return t.to;
    const u = Math.min(1, (at - t.started) / t.duration);
    return t.from + (t.to - t.from) * easeInOutCubic(u);
  }
}

function still(v: number): Tween {
  return { from: v, to: v, started: 0, duration: 0 };
}

function tween(from: number, to: number, duration: number): Tween {
  return { from, to, started: performance.now(), duration };
}

function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/**
 * The identity of a composition. For a formation it is built from the real counts only, so two
 * compositions are equal exactly when the data behind them is equal.
 */
function compositionKey(c: Composition): string {
  if (c.kind !== 'formation') return c.kind;
  const v = c.visual;
  return `formation:${v.figure}:${v.motion}:${v.resolved ?? 'null'}:${v.anchorMotes}:${v.threads}:${v.dissolve.toFixed(3)}`;
}

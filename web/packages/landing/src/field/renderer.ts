/**
 * The canvas renderer for the particle field.
 *
 * DELIBERATELY NOT A 3D RENDERER. ADR-0003 is unresolved, and the signed-out page must not
 * depend on its outcome or drag an engine into the first paint. Nothing in this package imports
 * three.js, Spark, PlayCanvas, `@orimera/atlas-three` or `@orimera/atlas-react`; the
 * forbidden-imports contract enforces that rather than trusting it.
 *
 * How the atmosphere is made, in four passes:
 *
 *   1. Ground. A vertical gradient, lerped between the pale landing palette and the deep Atlas
 *      palette by `theme`. The transition inward is a continuous change of ground, not a cut.
 *   2. Particles into two half-resolution luminance masks: one for body material, one for accent
 *      material. Half resolution is the diffusion: the upscale is the soft bloom, and it costs a
 *      quarter of the fill rate rather than a blur pass.
 *   3. Each mask is tinted through a gradient and composited, so the accents are iridescent
 *      across the frame instead of one flat blue.
 *   4. Grain and vignette. The grain is a pre-generated tile; under reduced motion it does not
 *      move, because a crawling grain field is exactly the low-amplitude motion the setting is
 *      asking us to stop.
 */

import { KIND } from './figure.js';
import type { ParticleField } from './particles.js';
import { mulberry32 } from './rng.js';

export interface Palette {
  readonly skyTop: string;
  readonly skyBottom: string;
  readonly bodyInk: readonly [string, string];
  readonly accentInk: readonly [string, string, string];
  readonly vignette: number;
  readonly grain: number;
  /**
   * Ink gain.
   *
   * The two grounds are not symmetric and pretending they are is what makes a dark theme look
   * empty. On the pale ground the ink is DARKER than the page, so a low alpha over a bright
   * background is already a strong mark. On the deep ground the same particles are composited
   * additively onto near-black, where a low alpha of a mid-tone colour adds almost nothing. The
   * gain is the correction, applied to sprite alpha rather than to the colours, so the two
   * palettes stay readable as the same palette.
   */
  readonly gain: number;
}

/** Pale negative space, deep blue ink. The signed-out page. */
export const PALE: Palette = {
  skyTop: '#f4f5f8',
  skyBottom: '#e2e6ef',
  bodyInk: ['#68738f', '#8892ab'],
  accentInk: ['#2b46b4', '#4a6ad6', '#7b62c9'],
  vignette: 0.14,
  grain: 0.045,
  gain: 1,
};

/** The Atlas interior. Same ink, inverted ground. */
export const DEEP: Palette = {
  skyTop: '#070a13',
  skyBottom: '#0b1120',
  bodyInk: ['#c3d2f2', '#93a6cf'],
  accentInk: ['#8ac9ff', '#c9edff', '#c9b4ff'],
  vignette: 0.42,
  grain: 0.06,
  gain: 1.9,
};

/**
 * Sprite radius in the half-resolution mask, alpha, and which mask the kind belongs to.
 *
 * Every sprite is a radial gradient falling to zero, never a hard disc. That is where the
 * diffusion comes from: a thousand hard dots read as confetti at any alpha, and the same thousand
 * soft dots read as haze. The upscale from the half-resolution mask then softens them again.
 */
const SPRITE: Readonly<Record<number, { r: number; a: number; accent: boolean }>> = {
  [KIND.MOTE]: { r: 5.8, a: 0.095, accent: false },
  [KIND.RING]: { r: 2.9, a: 0.5, accent: true },
  [KIND.CORE]: { r: 14, a: 0.3, accent: true },
  [KIND.STRUCTURE]: { r: 2.8, a: 0.42, accent: true },
  [KIND.UNCONFIRMED]: { r: 4.6, a: 0.34, accent: true },
};

/** A white radial gradient falling to zero. Drawn once per kind, then blitted per particle. */
function makeSprite(radius: number): HTMLCanvasElement {
  const size = Math.ceil(radius * 2) + 2;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, radius);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return c;
}

export interface FrameState {
  /** 0 = pale landing ground, 1 = deep Atlas ground. Animated across the entrance transition. */
  readonly theme: number;
  /** Field zoom about the composition centre. The dolly. */
  readonly zoom: number;
  /** Vertical offset of the composition centre, in units. */
  readonly panY: number;
  /** Horizontal offset of the composition centre, in units. The landing figure sits right of
   *  the text column; the Atlas figure is centred. */
  readonly panX: number;
  /** Whole-field opacity, used only for the reduced-motion cross-fade. */
  readonly opacity: number;
  /** Seconds since start. */
  readonly now: number;
  readonly reducedMotion: boolean;
}

export class FieldRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly body: HTMLCanvasElement;
  private readonly accent: HTMLCanvasElement;
  private readonly tint: HTMLCanvasElement;
  private grainTile: CanvasPattern | null = null;
  private readonly sprites = new Map<number, HTMLCanvasElement>();
  private width = 0;
  private height = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.body = document.createElement('canvas');
    this.accent = document.createElement('canvas');
    this.tint = document.createElement('canvas');
    for (const [kind, spec] of Object.entries(SPRITE)) {
      this.sprites.set(Number(kind), makeSprite(spec.r));
    }
    this.buildGrain();
  }

  /**
   * @param dpr device pixel ratio, capped by the caller. The cap is a comfort and thermal
   *   decision as much as a performance one: this field is soft by design and gains nothing
   *   visible above 1.5.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = Math.max(1, Math.round(cssWidth * dpr));
    this.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    const mw = Math.max(1, Math.round(this.width / 2));
    const mh = Math.max(1, Math.round(this.height / 2));
    for (const c of [this.body, this.accent, this.tint]) {
      c.width = mw;
      c.height = mh;
    }
  }

  render(field: ParticleField, state: FrameState): void {
    const p = lerpPalette(PALE, DEEP, clamp01(state.theme));
    const { ctx, width, height } = this;

    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, p.skyTop);
    sky.addColorStop(1, p.skyBottom);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    this.drawMasks(field, state, p.gain);

    // Accent first would be wrong: the body material is the atmosphere the accents sit inside.
    this.compositeMask(this.body, p.bodyInk, state);
    this.compositeMask(this.accent, p.accentInk, state);

    this.drawGrain(p.grain, state);
    this.drawVignette(p.vignette);
  }

  private drawMasks(field: ParticleField, state: FrameState, gain: number): void {
    const bodyCtx = this.body.getContext('2d');
    const accentCtx = this.accent.getContext('2d');
    if (!bodyCtx || !accentCtx) return;

    const mw = this.body.width;
    const mh = this.body.height;
    bodyCtx.clearRect(0, 0, mw, mh);
    accentCtx.clearRect(0, 0, mw, mh);
    bodyCtx.globalCompositeOperation = 'lighter';
    accentCtx.globalCompositeOperation = 'lighter';
    bodyCtx.fillStyle = '#ffffff';
    accentCtx.fillStyle = '#ffffff';

    // One unit is half the smaller dimension, so the composition is resolution independent.
    const unit = (Math.min(mw, mh) / 2) * state.zoom;
    const cx = mw / 2 + state.panX * unit;
    const cy = mh / 2 + state.panY * unit;

    for (let i = 0; i < field.count; i += 1) {
      const kind = field.kind[i] ?? KIND.MOTE;
      const spec = SPRITE[kind];
      if (!spec) continue;
      const sx = cx + (field.x[i] ?? 0) * unit;
      const sy = cy + (field.y[i] ?? 0) * unit;
      if (sx < -20 || sy < -20 || sx > mw + 20 || sy > mh + 20) continue;

      let alpha = spec.a;
      // Unconfirmed material never reaches full opacity and never settles. The oscillation is
      // per particle, driven by `KIND.UNCONFIRMED`, which the figure only ever assigns from real
      // semantic state. This is the dissolve, and it means something.
      if (kind === KIND.UNCONFIRMED) {
        const ph = field.phase[i] ?? 0;
        const flicker = state.reducedMotion ? 0.55 : 0.5 + 0.45 * Math.sin(state.now * 1.6 + ph * 3);
        alpha *= 0.35 + 0.5 * flicker;
      }

      const sprite = this.sprites.get(kind);
      if (!sprite) continue;
      const target = spec.accent ? accentCtx : bodyCtx;
      target.globalAlpha = Math.min(1, alpha * gain) * state.opacity;
      target.drawImage(sprite, sx - sprite.width / 2, sy - sprite.height / 2);
    }
  }

  /** Tint a luminance mask through a gradient and composite it onto the frame. */
  private compositeMask(mask: HTMLCanvasElement, stops: readonly string[], state: FrameState): void {
    const tctx = this.tint.getContext('2d');
    if (!tctx) return;
    const w = this.tint.width;
    const h = this.tint.height;

    tctx.globalCompositeOperation = 'source-over';
    tctx.globalAlpha = 1;
    tctx.clearRect(0, 0, w, h);
    tctx.drawImage(mask, 0, 0);

    const g = tctx.createLinearGradient(0, 0, w, h);
    stops.forEach((c, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c));
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = g;
    tctx.fillRect(0, 0, w, h);

    const ctx = this.ctx;
    // On the pale ground the ink darkens the page; on the deep ground it glows. The two are
    // cross-faded by `theme`, so the entrance never pops between two compositing modes.
    const deep = clamp01(state.theme);
    ctx.imageSmoothingEnabled = true;
    if (deep < 1) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1 - deep;
      ctx.drawImage(this.tint, 0, 0, this.width, this.height);
    }
    if (deep > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = deep;
      ctx.drawImage(this.tint, 0, 0, this.width, this.height);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private buildGrain(): void {
    const tile = document.createElement('canvas');
    tile.width = 128;
    tile.height = 128;
    const tctx = tile.getContext('2d');
    if (!tctx) return;
    const img = tctx.createImageData(128, 128);
    const rand = mulberry32(0x9241);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.round(rand() * 90);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    this.grainTile = this.ctx.createPattern(tile, 'repeat');
  }

  private drawGrain(strength: number, state: FrameState): void {
    if (!this.grainTile) return;
    const ctx = this.ctx;
    ctx.save();
    // A crawling grain field is low-amplitude peripheral motion, which is precisely what the
    // reduced-motion setting exists to remove. The grain stays, the crawl goes.
    if (!state.reducedMotion) {
      const t = Math.floor(state.now * 8);
      ctx.translate((t * 37) % 128, (t * 61) % 128);
    }
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = strength;
    ctx.fillStyle = this.grainTile;
    ctx.fillRect(-128, -128, this.width + 256, this.height + 256);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawVignette(strength: number): void {
    const { ctx, width, height } = this;
    const r = Math.hypot(width, height) / 2;
    const g = ctx.createRadialGradient(width / 2, height / 2, r * 0.42, width / 2, height / 2, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  return {
    skyTop: mixHex(a.skyTop, b.skyTop, t),
    skyBottom: mixHex(a.skyBottom, b.skyBottom, t),
    bodyInk: [mixHex(a.bodyInk[0], b.bodyInk[0], t), mixHex(a.bodyInk[1], b.bodyInk[1], t)],
    accentInk: [
      mixHex(a.accentInk[0], b.accentInk[0], t),
      mixHex(a.accentInk[1], b.accentInk[1], t),
      mixHex(a.accentInk[2], b.accentInk[2], t),
    ],
    vignette: a.vignette + (b.vignette - a.vignette) * t,
    grain: a.grain + (b.grain - a.grain) * t,
    gain: a.gain + (b.gain - a.gain) * t,
  };
}

export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

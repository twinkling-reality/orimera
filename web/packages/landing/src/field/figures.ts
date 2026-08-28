/**
 * The three compositions the landing surface ever holds, plus the formation figures.
 *
 * ORIGINALITY NOTE. The Companion motif is the one described in interaction-model.md 4.1: "a
 * slowly rotating assembly of thin concentric rings around a suspended luminous core", with "a
 * volumetric haze skirt". No face, no eyes, no limbs, no anthropomorphic proportions. It is an
 * original abstract form specified by this project's own design document, and it is deliberately
 * not a character: there is nothing here to infringe and nothing to fall into the uncanny valley.
 */

import { phyllotaxisSeed } from '@orimera/atlas-core';
import type { FormationVisual } from '../formation/index.js';
import { FigureBuilder, KIND, type Figure } from './figure.js';
import { gaussian, mulberry32 } from './rng.js';

/** Seeds are constants so that each composition is reproducible and reviewable. */
const SEED_COMPANION = 0xc0117a;
const SEED_ATLAS = 0xa71a5;
const SEED_FORMATION = 0xf0233;

/**
 * The Companion: five thin concentric rings around a suspended core, with a haze skirt below and
 * ambient dust around it.
 *
 * The rings are ellipses rather than circles because a circle reads as a target and an ellipse
 * reads as a ring seen at an angle, which is what makes a 2D field imply a body in space. Ring
 * particles are placed by golden angle rather than at even intervals so that no two rings ever
 * align into a spoke.
 */
export function companionFigure(capacity: number): Figure {
  const rand = mulberry32(SEED_COMPANION);
  const b = new FigureBuilder(capacity);

  const coreCount = Math.round(capacity * 0.05);
  for (let i = 0; i < coreCount; i += 1) {
    // Offset from the ring centre, not concentric with it: the core is SUSPENDED inside the
    // assembly rather than at its focus, which is what keeps a set of tilted ellipses around a
    // bright point from reading as an eye.
    b.push(-0.075 + gaussian(rand) * 0.032, -0.185 + gaussian(rand) * 0.042, KIND.CORE);
  }

  const ringCount = 4;
  const ringTotal = Math.round(capacity * 0.56);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let r = 0; r < ringCount; r += 1) {
    const t = r / (ringCount - 1);
    const radius = 0.26 + t * 0.46 + (r % 2 === 0 ? 0.022 : -0.017);
    // Each ring is tilted a little differently, so the assembly reads as loosely coupled rather
    // than as a single rigid object.
    const squash = 0.19 + t * 0.17;
    // A wide spread of tilts, so the assembly never resolves into a single symmetric shape.
    const tilt = (r - 1.5) * 0.34 + (r % 2 === 0 ? 0.09 : -0.12);
    const per = Math.round((ringTotal / ringCount) * (0.72 + t * 0.56));
    for (let i = 0; i < per; i += 1) {
      const a = i * golden + r * 1.7;
      const jitter = 1 + (rand() - 0.5) * 0.045;
      const x = Math.cos(a) * radius * jitter;
      const y = Math.sin(a) * radius * squash * jitter;
      b.push(
        x * Math.cos(tilt) - y * Math.sin(tilt),
        (x * Math.sin(tilt) + y * Math.cos(tilt)) - 0.06,
        KIND.RING,
      );
    }
  }

  // The haze skirt. Density falls off downward, so the form dissolves into the page instead of
  // ending at a hard edge, which is the same rule the islands follow (interaction-model.md 1.4).
  const skirt = Math.round(capacity * 0.18);
  for (let i = 0; i < skirt; i += 1) {
    const t = rand();
    const y = 0.3 + t * 0.95;
    const spread = 0.2 + t * 0.62;
    b.push(gaussian(rand) * spread * 0.5, y + gaussian(rand) * 0.06, KIND.MOTE);
  }

  ambientDust(b, rand, b.remaining);
  return b.build();
}

/**
 * The unformed Atlas: a faint horizon disc with three dim void volumes standing where regions
 * will be placed, and sparse between-space motes above.
 *
 * The three placements come from `phyllotaxisSeed`, the same deterministic seed the real layout
 * solver uses (interaction-model.md 1.4), so the entrance does not land the user in a hand-drawn
 * arrangement that the Atlas would then contradict.
 *
 * It is unformed on purpose. There is no geometry here because no capture has been processed, and
 * inventing three photoreal islands on a signed-out page would be exactly the kind of claim the
 * product refuses to make.
 */
export function unformedAtlasFigure(capacity: number): Figure {
  const rand = mulberry32(SEED_ATLAS);
  const b = new FigureBuilder(capacity);
  const horizon = 0.16;

  const seeds = phyllotaxisSeed(3, 0.62);
  const columnBudget = Math.round(capacity * 0.36 / seeds.length);
  for (const seed of seeds) {
    // z reads as depth: further islands sit nearer the horizon and are drawn smaller and dimmer.
    const depth = 1 / (1 + Math.abs(seed.z) * 0.55);
    const cx = seed.x * 1.15;
    const cy = horizon - seed.z * 0.06;
    for (let k = 0; k < columnBudget; k += 1) {
      const t = rand();
      const y = cy - t * 0.34 * depth;
      const spread = (0.13 + t * 0.05) * depth;
      b.push(cx + gaussian(rand) * spread, y + gaussian(rand) * 0.02, k % 9 === 0 ? KIND.RING : KIND.MOTE);
    }
  }

  discBand(b, rand, Math.round(capacity * 0.3), horizon, 1.7, 0.05);
  ambientDust(b, rand, b.remaining);
  return b.build();
}

/**
 * The formation figure for one capture, built from `FormationVisual`.
 *
 * Every count that appears in the geometry is a real count that arrived in an event. Where a
 * count would be illegible as geometry it is **not scaled up or padded**: the trajectory extent
 * grows with the measured fraction and carries no implied count at all, and anchor motes stop at
 * a legibility cap with the true number carried by the label beside them.
 */
export function formationFigure(capacity: number, visual: FormationVisual): Figure {
  const rand = mulberry32(SEED_FORMATION);
  const b = new FigureBuilder(capacity);
  const horizon = 0.2;
  // `resolved` is null whenever no fraction was measured. Nothing below may substitute a value
  // for it: a null fraction means the figure holds its unformed shape and breathes.
  const resolved = visual.resolved;

  switch (visual.figure) {
    case 'void':
      voidVolume(b, rand, Math.round(capacity * 0.45), horizon);
      break;

    case 'disc':
      voidVolume(b, rand, Math.round(capacity * 0.2), horizon);
      discBand(b, rand, Math.round(capacity * 0.42 * (resolved ?? 0.25)), horizon, 1.0, 0.035);
      break;

    case 'frusta':
      discBand(b, rand, Math.round(capacity * 0.3), horizon, 1.0 + (resolved ?? 0) * 0.5, 0.04);
      trajectory(b, rand, horizon, resolved ?? 0.15);
      break;

    case 'surfaces':
      discBand(b, rand, Math.round(capacity * 0.26), horizon, 1.3, 0.04);
      trajectory(b, rand, horizon, 1);
      surfaces(b, rand, Math.round(capacity * 0.34), horizon, resolved);
      break;

    case 'anchors':
      discBand(b, rand, Math.round(capacity * 0.24), horizon, 1.3, 0.04);
      surfaces(b, rand, Math.round(capacity * 0.3), horizon, 1);
      anchorMotes(b, rand, horizon, visual.anchorMotes, visual.dissolve);
      break;

    case 'threads':
      discBand(b, rand, Math.round(capacity * 0.24), horizon, 1.3, 0.04);
      surfaces(b, rand, Math.round(capacity * 0.28), horizon, 1);
      anchorMotes(b, rand, horizon, visual.anchorMotes, visual.dissolve);
      threads(b, horizon, visual.threads);
      break;

    case 'formed':
      discBand(b, rand, Math.round(capacity * 0.24), horizon, 1.3, 0.04);
      surfaces(b, rand, Math.round(capacity * 0.3), horizon, visual.motion === 'stopped' ? 0.45 : 1);
      anchorMotes(b, rand, horizon, visual.anchorMotes, visual.dissolve);
      break;
  }

  ambientDust(b, rand, b.remaining);
  return b.build();
}

// ---------------------------------------------------------------------------------------------

/**
 * The leftover field: sparse dust spread wider than the viewport.
 *
 * Wider on purpose. Dust confined to the frame reads as a texture applied to a rectangle; dust
 * that runs off every edge reads as the room the composition is standing in.
 */
function ambientDust(b: FigureBuilder, rand: () => number, count: number): void {
  for (let i = 0; i < count; i += 1) {
    b.push((rand() - 0.5) * 4.6, (rand() - 0.5) * 3.4, KIND.MOTE);
  }
}

/** A wide, low ellipse of motes: the ground plane, seen almost edge on. */
function discBand(
  b: FigureBuilder,
  rand: () => number,
  count: number,
  y: number,
  width: number,
  thickness: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    b.push(Math.cos(a) * r * width, y + Math.sin(a) * r * thickness + gaussian(rand) * 0.012, KIND.MOTE);
  }
}

/** A dim unlit column standing where the region will be. Sparse motes drifting inward. */
function voidVolume(b: FigureBuilder, rand: () => number, count: number, horizon: number): void {
  for (let i = 0; i < count; i += 1) {
    const t = rand();
    const y = horizon - t * 0.5;
    const spread = 0.2 + t * 0.12;
    b.push(gaussian(rand) * spread, y + gaussian(rand) * 0.03, KIND.MOTE);
  }
}

/**
 * The recovered camera trajectory, drawn as thin frusta along an arc.
 *
 * `extent` is the measured fraction of the trajectory that has been recovered. The number of
 * frusta drawn is fixed and is a sampling of the path, not a count of registered images: a count
 * the eye could read off the picture would be a second, weaker channel for a number the label
 * already states exactly.
 */
function trajectory(b: FigureBuilder, rand: () => number, horizon: number, extent: number): void {
  const samples = 9;
  const span = Math.max(0, Math.min(1, extent));
  for (let i = 0; i < samples; i += 1) {
    const t = (i / (samples - 1)) * span;
    const a = -1.15 + t * 2.3;
    const cx = Math.sin(a) * 0.78;
    const cy = horizon - 0.1 - Math.cos(a) * 0.06;
    const s = 0.055;
    // Five points: apex plus the four corners of the image plane.
    b.push(cx, cy, KIND.STRUCTURE);
    for (const [dx, dy] of [
      [-s, -s * 0.7],
      [s, -s * 0.7],
      [s, s * 0.7],
      [-s, s * 0.7],
    ] as const) {
      b.push(cx + dx * 1.6 + rand() * 0.004, cy + dy * 1.6, KIND.STRUCTURE);
    }
  }
}

/**
 * Motes migrating onto surfaces.
 *
 * `converged` is null when no fraction was measured, and in that case nothing migrates: the
 * points stay loose in the volume and the renderer breathes them. That is the honest rendering of
 * "we do not know how far along this is".
 */
function surfaces(
  b: FigureBuilder,
  rand: () => number,
  count: number,
  horizon: number,
  converged: number | null,
): void {
  const onSurface = converged === null ? 0 : Math.round(count * converged);
  for (let i = 0; i < count; i += 1) {
    if (i < onSurface) {
      // Two broad planes and a back wall: enough to read as structure, honest about being a
      // silhouette rather than a room.
      const which = i % 3;
      const u = rand() - 0.5;
      const v = rand();
      if (which === 0) b.push(u * 1.5, horizon - v * 0.02, KIND.MOTE);
      else if (which === 1) b.push(-0.62 + u * 0.16, horizon - v * 0.42, KIND.MOTE);
      else b.push(0.58 + u * 0.2, horizon - v * 0.38, KIND.MOTE);
    } else {
      b.push(gaussian(rand) * 0.42, horizon - rand() * 0.44, KIND.MOTE);
    }
  }
}

/** The legibility cap. Above it, motes stop appearing and the label carries the true count. */
export const ANCHOR_MOTE_CAP = 64;

/**
 * One mote per detection that has actually landed. Never a target, never a preview.
 *
 * `dissolve` is the share of them that read as unconfirmed, and it comes from real semantic state
 * (open questions over indexed detections), so an unconfirmed candidate looks unconfirmed because
 * it is, not because the composition wanted texture.
 */
function anchorMotes(
  b: FigureBuilder,
  rand: () => number,
  horizon: number,
  motes: number,
  dissolve: number,
): void {
  const drawn = Math.min(motes, ANCHOR_MOTE_CAP);
  const unconfirmed = Math.round(drawn * Math.max(0, Math.min(1, dissolve)));
  for (let i = 0; i < drawn; i += 1) {
    const a = (i / Math.max(1, drawn)) * Math.PI * 2 + rand() * 0.3;
    const r = 0.18 + rand() * 0.5;
    b.push(
      Math.cos(a) * r,
      horizon - 0.08 - Math.abs(Math.sin(a)) * r * 0.5,
      i < unconfirmed ? KIND.UNCONFIRMED : KIND.RING,
    );
  }
}

/** One thread per candidate link compared, reaching toward where existing regions sit. */
function threads(b: FigureBuilder, horizon: number, count: number): void {
  const perThread = 22;
  for (let t = 0; t < count; t += 1) {
    const dir = t % 2 === 0 ? -1 : 1;
    const lift = 0.34 + t * 0.06;
    for (let i = 0; i < perThread; i += 1) {
      const u = i / (perThread - 1);
      // A catenary, which is what a hanging link between two points actually looks like and what
      // the Atlas Map draws for the same relationship.
      const x = u * 1.55 * dir;
      const y = horizon - 0.16 - lift * (1 - Math.cosh((u - 0.5) * 2.2) / Math.cosh(1.1));
      b.push(x, y, KIND.STRUCTURE);
    }
  }
}

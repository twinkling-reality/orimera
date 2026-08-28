import { intrinsics, resolutionFor } from './camera.js';
import type { HonestyParams } from './honesty.js';
import { DEFAULT_HONESTY, computeKeepMask } from './honesty.js';
import type { PointMap } from './pointmap.js';
import { buildPointMap } from './pointmap.js';
import { rasterDepth } from './raster.js';
import { CAMERA_HEIGHT, PRIMITIVES, SEGMENTS } from './scene.js';
import { trimToExactly } from './select.js';
import type { OpmMetadata } from './format/opm.js';

export const GENERATOR = '@orimera/scene-synth 0.1.0';

/** The bake-off ladder from ADR-0003 experiment X-R1, plus a 250k entry for a rung 3 floor. */
export const POINT_LADDER: readonly number[] = Object.freeze([
  250_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000,
]);

export interface GenerateOptions {
  readonly targetPoints: number;
  readonly seed: number;
  readonly fovYDeg: number;
  readonly aspect: number;
  readonly depthBias: number;
  readonly depthJitter: number;
  readonly honesty: HonestyParams;
}

export const DEFAULT_GENERATE: Omit<GenerateOptions, 'targetPoints'> = Object.freeze({
  seed: 20260827,
  // A phone main camera on a 4:3 sensor: about 26 mm equivalent.
  fovYDeg: 55,
  aspect: 4 / 3,
  depthBias: 0.0016,
  depthJitter: 0.0022,
  honesty: DEFAULT_HONESTY,
});

export interface GenerateResult {
  readonly points: PointMap;
  readonly meta: OpmMetadata;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly validFraction: number;
  readonly attempts: number;
  readonly elapsedMs: number;
}

const EYE: readonly [number, number, number] = [0, CAMERA_HEIGHT, 0];

/**
 * Generate one rung of the ladder.
 *
 * The resolution is SOLVED FOR rather than fixed, which matters more than it looks. A real point
 * map has one point per valid pixel, so the honest way to reach 4M points is to photograph the
 * same place at a higher resolution, not to sample a low-resolution map more densely. Solving for
 * resolution keeps every rung a genuine per-pixel point map: silhouettes get crisper and thin
 * structures survive better at 4M, exactly as they would with a bigger sensor. Sampling a fixed
 * grid harder would instead produce duplicate points on a lattice, which is not a workload any
 * renderer will ever see.
 */
export function generatePointMap(options: Partial<GenerateOptions> & { targetPoints: number }): GenerateResult {
  const opts: GenerateOptions = { ...DEFAULT_GENERATE, ...options };
  const started = Date.now();

  // Probe: run the whole pipeline small to learn the valid-pixel fraction for this scene and
  // these honesty parameters. Cheap, and it makes the search converge in one step almost always.
  const probeRes = resolutionFor(60_000, 1, opts.aspect);
  const probeK = intrinsics(probeRes.width, probeRes.height, opts.fovYDeg);
  const probeBuf = rasterDepth(PRIMITIVES, probeK, {
    eye: EYE,
    seed: opts.seed,
    depthBias: opts.depthBias,
    depthJitter: opts.depthJitter,
  });
  const probeMask = computeKeepMask(
    probeBuf,
    probeK,
    SEGMENTS,
    PRIMITIVES,
    EYE,
    opts.seed,
    opts.honesty,
  );
  let validFraction = probeMask.keptCount / (probeRes.width * probeRes.height);
  if (validFraction <= 0) throw new Error('the scene produced no valid pixels at probe resolution');

  let attempts = 0;
  let width = 0;
  let height = 0;
  let buf = probeBuf;
  let mask = probeMask;

  for (attempts = 1; attempts <= 4; attempts += 1) {
    const res = resolutionFor(opts.targetPoints, validFraction, opts.aspect);
    width = res.width;
    height = res.height;
    const k = intrinsics(width, height, opts.fovYDeg);
    buf = rasterDepth(PRIMITIVES, k, {
      eye: EYE,
      seed: opts.seed,
      depthBias: opts.depthBias,
      depthJitter: opts.depthJitter,
    });
    mask = computeKeepMask(buf, k, SEGMENTS, PRIMITIVES, EYE, opts.seed, opts.honesty);
    if (mask.keptCount >= opts.targetPoints) break;
    // Undershot. The observed fraction is the better estimate; nudge it down slightly so the
    // next attempt overshoots rather than oscillating.
    validFraction = (mask.keptCount / (width * height)) * 0.97;
  }

  if (mask.keptCount < opts.targetPoints) {
    throw new Error(
      `could not reach ${opts.targetPoints} points after ${attempts} attempts (best ${mask.keptCount})`,
    );
  }

  const k = intrinsics(width, height, opts.fovYDeg);
  const count = trimToExactly(
    mask.keep,
    width,
    height,
    mask.keptCount,
    opts.targetPoints,
    opts.seed,
  );

  const points = buildPointMap(
    buf,
    k,
    mask.keep,
    mask.confidence,
    count,
    SEGMENTS,
    PRIMITIVES,
    EYE,
    opts.seed,
    opts.depthJitter,
  );

  const pixels = width * height;
  const meta: OpmMetadata = {
    generator: GENERATOR,
    seed: opts.seed,
    sceneName: 'harbour',
    viewpoint: {
      position: EYE,
      forward: [0, 0, -1],
      up: [0, 1, 0],
      fovYDeg: opts.fovYDeg,
      aspect: opts.aspect,
    },
    sourceImage: { width, height },
    metric: true,
    segments: SEGMENTS,
    statistics: {
      sourcePixels: pixels,
      pixelsWithSurface: buf.hitCount,
      pixelsUnobserved: mask.stats.missed,
      pixelsCarvedAtOcclusionBoundaries: mask.stats.carved,
      pixelsDroppedGrazing: mask.stats.grazingDropped,
      pixelsDroppedLowTexture: mask.stats.textureDropped,
      pixelsDroppedAtRange: mask.stats.rangeDropped,
      pixelsSurviving: mask.keptCount,
      pointsWritten: count,
      validFraction: mask.keptCount / pixels,
      trimmedForExactCount: mask.keptCount - count,
    },
  };

  return {
    points,
    meta,
    sourceWidth: width,
    sourceHeight: height,
    validFraction: mask.keptCount / pixels,
    attempts,
    elapsedMs: Date.now() - started,
  };
}

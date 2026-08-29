/**
 * Bake the reconstruction-ladder figure from the project's own scene generator.
 *
 * OUTSIDE `packages/` ON PURPOSE. The landing package is contractually forbidden from importing
 * the scene generator, and rightly: nothing the browser downloads should be able to reach it. This
 * script does reach it, so it does not live in that package. Keeping it here makes the separation
 * structural rather than an exception written into the contract, and `pnpm boundaries` cruises
 * `packages`, so it is out of scope by construction.
 *
 * The figure is not a drawing of a point cloud. It IS one: the same synthetic capture sampled at
 * the three densities the fallback ladder actually produces, projected from a rotated viewpoint so
 * that the generator's real occlusion boundaries face the reader. The notch bitten out of the
 * facade is where the camera could not see, and it is there because the geometry says so.
 *
 * Baked at author time rather than imported at runtime, for two reasons. The landing package must
 * not grow a dependency on the scene generator to draw one picture, and the picture never changes
 * between visitors, so shipping the generator to every browser would be paying repeatedly for a
 * constant.
 *
 *   npx tsx scripts/bake-ladder.ts
 */
import { writeFileSync } from 'node:fs';
import { generatePointMap } from '../packages/scene-synth/src/generate.js';

const W = 440;
const H = 150;
const GAP = 22;
/** Points kept per panel: rung 1, rung 3, rung 4. Ratios, not absolutes; see the caption. */
const RUNGS = [9000, 1500, 190];

const res = generatePointMap({ targetPoints: 400_000 });
const pm = res.points;

/** Yaw the camera-space geometry so the occluded side is visible as a hole rather than as an edge. */
const YAW = (28 * Math.PI) / 180;
const cy = Math.cos(YAW);
const sy = Math.sin(YAW);

interface P { x: number; y: number; t: number }
const raw: { x: number; y: number; d: number; a: number }[] = [];
for (let i = 0; i < pm.count; i += 1) {
  const X = pm.position[i * 3]!;
  const Y = pm.position[i * 3 + 1]!;
  const Z = pm.position[i * 3 + 2]!;
  raw.push({ x: X * cy + Z * sy, y: Y, d: -X * sy + Z * cy, a: pm.color[i * 4 + 3]! / 255 });
}

// Percentile bounds rather than min/max: a handful of far sky samples would otherwise set the
// scale and squash the part of the scene that has structure in it.
const pct = (arr: number[], q: number): number => arr[Math.floor(q * (arr.length - 1))]!;
const xs = raw.map((p) => p.x).sort((a, b) => a - b);
const ys = raw.map((p) => p.y).sort((a, b) => a - b);
const ds = raw.map((p) => p.d).sort((a, b) => a - b);
const x0 = pct(xs, 0.1);
const x1 = pct(xs, 0.9);
const y0 = pct(ys, 0.16);
const y1 = pct(ys, 0.995);
const d0 = pct(ds, 0.02);
const d1 = pct(ds, 0.98);

const pts: P[] = raw
  .map((p) => ({
    x: ((p.x - x0) / (x1 - x0)) * W,
    y: H - ((p.y - y0) / (y1 - y0)) * H,
    t: Math.min(1, Math.max(0, (p.d - d0) / (d1 - d0))),
    a: p.a,
  }))
  .filter((p) => p.x > -2 && p.x < W + 2 && p.y > -2 && p.y < H + 2 && p.a > 0.35);

/** One depth band as a single path of hairline dashes: far smaller than a circle per point. */
function band(keep: number, near: boolean): string {
  const step = Math.max(1, Math.round(pts.length / keep));
  let d = '';
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i]!;
    if (near ? p.t > 0.55 : p.t <= 0.55) continue;
    d += `M${p.x.toFixed(1)} ${p.y.toFixed(1)}h.6`;
  }
  return d;
}

const LABELS = ['Rung 1', 'Rung 3', 'Rung 4'];
let svg = `<svg viewBox="0 0 ${W} ${(H + GAP) * RUNGS.length}" role="presentation">`;
RUNGS.forEach((keep, i) => {
  svg += `<g transform="translate(0 ${i * (H + GAP)})">`;
  // Far band first and fainter, so the panel recedes instead of reading as one flat spray.
  svg += `<path d="${band(keep, false)}" stroke="currentColor" stroke-width=".85" stroke-linecap="round" fill="none" opacity=".26"/>`;
  svg += `<path d="${band(keep, true)}" stroke="currentColor" stroke-width=".85" stroke-linecap="round" fill="none" opacity=".68"/>`;
  svg += `<text x="0" y="${H + 13}" font-size="8" letter-spacing="1.6" fill="currentColor" opacity=".5">${LABELS[i]!.toUpperCase()}</text>`;
  svg += `</g>`;
});
svg += `</svg>`;

const out = `/**
 * GENERATED. Do not edit by hand.
 *
 * Written by \`packages/landing/scripts/bake-ladder.ts\` from the real output of
 * \`@orimera/scene-synth\`. The holes are the generator's own occlusion boundaries.
 *
 * Source capture: ${pm.count.toLocaleString('en-US')} points, valid-pixel fraction ${res.validFraction.toFixed(3)}.
 */
export const LADDER_FIGURE = ${JSON.stringify(svg)};
`;
writeFileSync(new URL('../packages/landing/src/ui/ladder-figure.ts', import.meta.url), out);
process.stdout.write(`baked ${svg.length} bytes, valid fraction ${res.validFraction.toFixed(3)}\n`);

import type { AtlasVec3 } from './coords.js';
import { dot, sub } from './coords.js';

/**
 * DISTANCE OVER ATLAS POSITIONS. PRESENTATION ONLY.
 *
 * interaction-model.md 1.2 requires that no distance function over AtlasVec3 be exported from
 * the query layer, because an island's atlas position is a layout artifact and reading it as
 * geometry collapses the product's central honesty claim (risk R-48).
 *
 * The layout solver and the focus solver genuinely need atlas-space distance, and they are not
 * the query layer: they are deciding where to draw things and what the reticle is pointing at.
 * So the functions exist, they live in this one file, and this file is:
 *
 *   - NOT re-exported from `index.ts`, so `import { atlasDistance } from '@orimera/atlas-core'`
 *     does not resolve;
 *   - reachable only as `@orimera/atlas-core/presentation-metrics`;
 *   - forbidden to world-index, companion-runtime, graph-client and scene-synth by the
 *     `no-atlas-distance-outside-presentation` rule in `.dependency-cruiser.cjs`.
 *
 * A number produced here may drive a pixel. It may never drive a sentence.
 */

/** Squared atlas-unit distance. Prefer this in inner loops; it avoids a sqrt. */
export function atlasDistanceSq(a: AtlasVec3, b: AtlasVec3): number {
  const d = sub(a, b);
  return dot(d, d);
}

/** Atlas-unit distance. Presentation only. */
export function atlasDistance(a: AtlasVec3, b: AtlasVec3): number {
  return Math.sqrt(atlasDistanceSq(a, b));
}

/**
 * Horizontal atlas distance, ignoring height.
 *
 * The layout solver works on the ground plane because islands share a global up vector
 * (interaction-model.md 1.2) and are never pitched or rolled.
 */
export function atlasGroundDistance(a: AtlasVec3, b: AtlasVec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

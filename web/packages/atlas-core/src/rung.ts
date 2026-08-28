/**
 * The reconstruction fallback ladder (product-specification.md section 5), as a first-class
 * property of an island rather than a rendering detail.
 *
 * Two reasons it lives in atlas-core and not in the renderer binding:
 *
 *   1. It is DISPLAYED (5.1). "The reconstruction rung a scene earned is displayed, not hidden.
 *      The ladder is the honesty feature." A property the UI must show is scene-graph state.
 *   2. It constrains the camera. A rung 2 island is a spline-constrained corridor, so the
 *      containment model is a function of the rung, and containment is atlas-core's problem
 *      under either ADR-0003 outcome.
 */

export type ReconstructionRung = 1 | 2 | 3 | 4;

/**
 * What the user may do with their camera inside an island. Derived from the rung, never set
 * independently, so an island cannot claim free movement it did not earn.
 */
export type MovementModel =
  /** Rung 1: free movement inside a photoreal region. */
  | 'free'
  /** Rung 2: a spline through the recovered trajectory, with a bounded lateral envelope. */
  | 'corridor'
  /** Rung 3: a constellation of 2.5D photographic panels, each with a few degrees of parallax. */
  | 'panels'
  /** Rung 4: evidence cards laid out by time and semantic proximity. No geometry. */
  | 'cards';

export interface RungProperties {
  readonly rung: ReconstructionRung;
  readonly movement: MovementModel;
  /**
   * Stable key for the user-facing label. product-specification.md P-2 records the exact copy as
   * OPEN ("copy not written; the constraint is fixed, the wording is not"), so atlas-core carries
   * the key and refuses to invent the sentence. The constraint that IS fixed is enforced below.
   */
  readonly labelKey: `rung.${ReconstructionRung}`;
  /**
   * The fixed constraint from 5.2: no label may imply free movement in an island that does not
   * have it. A UI that renders a label for a rung whose `impliesFreeMovement` is false and whose
   * copy says "walk anywhere" is violating the spec; this flag is what a copy test asserts on.
   */
  readonly impliesFreeMovement: boolean;
}

const TABLE: Readonly<Record<ReconstructionRung, RungProperties>> = Object.freeze({
  1: Object.freeze({ rung: 1, movement: 'free', labelKey: 'rung.1', impliesFreeMovement: true }),
  2: Object.freeze({ rung: 2, movement: 'corridor', labelKey: 'rung.2', impliesFreeMovement: false }),
  3: Object.freeze({ rung: 3, movement: 'panels', labelKey: 'rung.3', impliesFreeMovement: false }),
  4: Object.freeze({ rung: 4, movement: 'cards', labelKey: 'rung.4', impliesFreeMovement: false }),
} as const);

export function rungProperties(rung: ReconstructionRung): RungProperties {
  const p = TABLE[rung];
  /* c8 ignore next */
  if (p === undefined) throw new RangeError(`unknown reconstruction rung: ${String(rung)}`);
  return p;
}

/**
 * The rung a single photograph earns.
 *
 * product-specification.md 5: rung 3 is "per image monocular metric point maps, no poses
 * required" with "no gate that can fail". The single-photo path is the primary experience, so
 * this is the rung the synthetic scene generator produces, and the one the bake-off measures.
 */
export const SINGLE_PHOTO_RUNG: ReconstructionRung = 3;

import type { Anchor } from '../anchor.js';

/**
 * Derived importance (interaction-model.md 3.3).
 *
 * "importance is derived rather than authored: unresolved status, current view emphasis, and
 * normalized occurrence count. A recomposition therefore automatically makes the relevant things
 * easier to aim at, which is a real ergonomic payoff for free."
 *
 * The document names the three inputs and does not give their weights. These are a decision, not
 * a transcription, and they are here in one place so that tuning them is one edit. The ordering
 * they encode: what the current query is about matters most, then whether the system still has a
 * question about it, then how often it recurs.
 */
export const IMPORTANCE_WEIGHTS = Object.freeze({
  emphasis: 0.4,
  unresolved: 0.35,
  occurrence: 0.25,
});

/**
 * @param emphasisScalar the anchor's current emphasis, 0..1, from the applied view manifest
 * @param occurrenceNormalizer the largest occurrence count in the scene, for normalisation
 */
export function deriveImportance(
  anchor: Anchor,
  emphasisScalar: number,
  occurrenceNormalizer: number,
): number {
  const occ =
    occurrenceNormalizer > 0 ? Math.min(1, anchor.occurrenceCount / occurrenceNormalizer) : 0;
  return (
    IMPORTANCE_WEIGHTS.emphasis * emphasisScalar +
    IMPORTANCE_WEIGHTS.unresolved * (anchor.resolved ? 0 : 1) +
    IMPORTANCE_WEIGHTS.occurrence * occ
  );
}

/** Largest occurrence count in the table, computed once per layout rather than per frame. */
export function occurrenceNormalizer(anchors: readonly Anchor[]): number {
  let max = 0;
  for (const a of anchors) if (a.occurrenceCount > max) max = a.occurrenceCount;
  return max;
}

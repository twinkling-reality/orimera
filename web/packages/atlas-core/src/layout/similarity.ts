import type { Anchor } from '../anchor.js';
import type { EntityId } from '../ids.js';
import { contributesToLayout } from '../provenance.js';

/**
 * Semantic proximity, which is the ONLY thing that decides where islands go.
 *
 * interaction-model.md 1.4: "Target separation is derived from a semantic similarity score
 * dominated by shared CONFIRMED or HIGH-CONFIDENCE entities. Speculative links must never move
 * the world; otherwise the layout twitches every time the pipeline guesses."
 *
 * The filter is applied when the entity set is BUILT, not when the score is read, so a caller
 * that forgets to filter cannot let a `proposed` link move an island. That is why
 * `layoutEntitiesOf` exists rather than leaving callers to assemble the set themselves.
 */

export function layoutEntitiesOf(anchors: readonly Anchor[]): ReadonlySet<EntityId> {
  const out = new Set<EntityId>();
  for (const a of anchors) {
    if (a.entityId === null) continue;
    if (!contributesToLayout(a.linkState, a.confidence)) continue;
    out.add(a.entityId);
  }
  return out;
}

/**
 * Jaccard over the layout-eligible entity sets: shared entities over total distinct entities.
 *
 * Jaccard rather than raw overlap count because raw overlap makes a big island close to
 * everything, which would collapse the layout around whichever capture happens to be largest.
 * Two islands with no eligible entities score 0 and are pushed apart by the separation term,
 * which is the correct reading: we know of nothing connecting them.
 */
export function semanticSimilarity(
  a: ReadonlySet<EntityId>,
  b: ReadonlySet<EntityId>,
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (large.has(id)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Thread strength for the Atlas Map (interaction-model.md 6.2): "cross-region threads whose
 * thickness is proportional to shared confirmed entities". Count, not Jaccard, because the map
 * is showing how much evidence connects two islands, not how similar they are.
 */
export function sharedLayoutEntityCount(
  a: ReadonlySet<EntityId>,
  b: ReadonlySet<EntityId>,
): number {
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (large.has(id)) shared += 1;
  return shared;
}

/**
 * The closed intent set (interaction-model.md 4.4, stage 1).
 *
 * "Select an intent from a small closed set, BY PRIORITY: resolve identity, confirm continuity,
 * enrich relation, disambiguate claim, acknowledge."
 *
 * The set is closed and the order is the document's. Both are encoded as data so that "the
 * Companion asked the wrong kind of question" is a diffable one-line change and not an
 * archaeology exercise across a generator function.
 */

export type Intent =
  /** There is a person (or place, or object) with occurrences and no name. */
  | 'resolve_identity'
  /** A named entity may also be the entity in another capture. The cross-capture question. */
  | 'confirm_continuity'
  /** We know who, and we could know how they relate. */
  | 'enrich_relation'
  /** Two active assertions disagree (5.4). Never resolved silently; always asked. */
  | 'disambiguate_claim'
  /** Nothing is open. The Companion acknowledges and stops. */
  | 'acknowledge';

/**
 * Priority order. Lower is more urgent.
 *
 * `disambiguate_claim` sits fourth because the document lists it fourth, which reads oddly next
 * to 5.4's insistence that a contradiction is never applied silently. It is not a conflict: 5.4
 * governs what happens to the DATA (recorded, surfaced, never applied), this governs which
 * question gets ASKED first when several are open. A contradiction is already visible in the
 * index as needs-review whether or not the Companion raises it this turn.
 */
export const INTENT_PRIORITY: readonly Intent[] = Object.freeze([
  'resolve_identity',
  'confirm_continuity',
  'enrich_relation',
  'disambiguate_claim',
  'acknowledge',
]);

export function intentRank(intent: Intent): number {
  const i = INTENT_PRIORITY.indexOf(intent);
  /* c8 ignore next */
  if (i < 0) throw new RangeError(`unknown intent: ${intent}`);
  return i;
}

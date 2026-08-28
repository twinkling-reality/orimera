import type { ConsequenceTier, EntityRecord } from '@orimera/graph-client';
import type { ConfirmationSurface, TierPolicy } from '@orimera/companion-runtime';
import { assertBatchable, tierPolicy } from '@orimera/companion-runtime';

/**
 * ENTITY ACTIONS AND THEIR TIERS (interaction-model.md 6.1).
 *
 * "Actions and their tiers: Locate (0), Inspect (0), Edit (1), Review (0, produces 1 or 2),
 * Merge (2), Split (2), Delete (3, AND THE ONLY PLACE DELETE EXISTS)."
 *
 * The tiers are transcribed here and the OBLIGATIONS are not: those come from
 * companion-runtime's `tierPolicy`, which is the same table the dialogue panel obeys. If the two
 * surfaces disagreed about what a merge requires, the user would learn that where they clicked
 * changed what they were promised.
 */

export type IndexAction = 'locate' | 'inspect' | 'edit' | 'review' | 'merge' | 'split' | 'delete';

export const ACTION_ORDER: readonly IndexAction[] = Object.freeze([
  'locate',
  'inspect',
  'review',
  'edit',
  'merge',
  'split',
  'delete',
]);

export const ACTION_TIER: Readonly<Record<IndexAction, ConsequenceTier>> = Object.freeze({
  locate: 0,
  inspect: 0,
  edit: 1,
  review: 0,
  merge: 2,
  split: 2,
  delete: 3,
});

/** Review is tier 0 to open and produces a tier 1 or tier 2 proposal depending on the answer. */
export const REVIEW_PRODUCES: readonly ConsequenceTier[] = Object.freeze([1, 2]);

export interface ActionOffer {
  readonly action: IndexAction;
  readonly tier: ConsequenceTier;
  readonly policy: TierPolicy;
  readonly available: boolean;
  readonly unavailableReasonKey: string | null;
  readonly labelKey: string;
}

/**
 * Which actions this entity offers on this surface.
 *
 * Delete is present in the list and UNAVAILABLE rather than absent, when the surface allows it at
 * all. That is the Yarn Spinner availability semantics again (4.4 stage 3): the reason is the
 * information. A user looking for "how do I forget this person" should find the control and read
 * why it is not active yet, rather than conclude the feature does not exist.
 *
 * On the dialogue surface delete is not listed at all, because 5.3 says it is "never offered as a
 * dialogue option ... in any phrasing", and an unavailable-with-a-reason row is still an offer.
 */
export function availableActions(
  entity: EntityRecord,
  surface: ConfirmationSurface = 'world_index',
): readonly ActionOffer[] {
  const offers: ActionOffer[] = [];
  for (const action of ACTION_ORDER) {
    const tier = ACTION_TIER[action];
    const policy = tierPolicy(tier);
    if (!policy.offerableFrom.includes(surface)) continue;

    let available = true;
    let reason: string | null = null;

    if (!policy.inMvp) {
      available = false;
      reason = 'unavailable.outOfMvpCut';
    } else if (action === 'review' && entity.status !== 'needs_review') {
      available = false;
      reason = 'unavailable.nothingToReview';
    } else if (action === 'split' && entity.occurrenceCount < 2) {
      // Splitting requires a partition, and a single occurrence has no non-trivial one.
      available = false;
      reason = 'unavailable.nothingToSplit';
    } else if (entity.mergedInto !== null) {
      available = action === 'inspect' || action === 'locate';
      reason = available ? null : 'unavailable.mergedAway';
    }

    offers.push(
      Object.freeze({
        action,
        tier,
        policy,
        available,
        unavailableReasonKey: reason,
        labelKey: `action.${action}`,
      }),
    );
  }
  return Object.freeze(offers);
}

/**
 * Filter a batch selection down to what may legally be batched.
 *
 * 6.3: "Batch operations are permitted for TIER 1 ONLY. Prohibited at tier 2 and above, because a
 * blast radius cannot be previewed meaningfully for a set, and merge is exactly the operation
 * where the user most needs to see the consequence before committing."
 *
 * It throws rather than filters, because a UI that offered "merge 12 selected" and silently
 * merged none of them would be worse than one that refused to render the control.
 */
export function assertBatchAllowed(action: IndexAction): void {
  assertBatchable(ACTION_TIER[action]);
}

export function batchableActions(): readonly IndexAction[] {
  return ACTION_ORDER.filter((a) => tierPolicy(ACTION_TIER[a]).batchable);
}

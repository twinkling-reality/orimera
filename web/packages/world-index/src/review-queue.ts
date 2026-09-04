import type { GraphSnapshot } from '@exulanica/graph-client';
import type { CompanionMemory } from '@exulanica/companion-runtime';
import { EMPTY_MEMORY, rankByValue } from '@exulanica/companion-runtime';
import type { IndexFacets } from './facets.js';
import { ALL_FACETS, applyFacets } from './facets.js';
import type { IndexRow } from './rows.js';
import { toRow } from './rows.js';
import type { IndexAction } from './actions.js';

/**
 * THE REVIEW QUEUE (interaction-model.md 6.3).
 *
 * "DECISION: THE REVIEW QUEUE IS NOT A FEATURE, IT IS A PRESET. It is the World Index filtered to
 * 'needs review', sorted by the same value function that drives Companion initiative, with review
 * as the default detail action. Same component tree, same runtime, same proposal flow."
 *
 * So there is no queue component here. There is a facet preset, a sort, and a default action. The
 * rows come from `toRow`, the same function the browse path uses, which is what makes the
 * document's first consequence true: "the review path and the browse path can never diverge in
 * behaviour or in provenance display, BECAUSE THEY ARE THE SAME CODE".
 *
 * The second consequence is the one that has to be actively defended, and it is defended by what
 * this file does NOT export: "the queue cannot become a completion-driven chore surface ...
 * there is a count, THERE IS NO '0 of 12 complete', no progress ring, no streak". There is no
 * total field, no completed field and no percentage anywhere in `ReviewQueueView`, so a binding
 * cannot render one without inventing it.
 */

export const REVIEW_QUEUE_FACETS: IndexFacets = Object.freeze({
  ...ALL_FACETS,
  statuses: Object.freeze(['needs_review' as const]),
});

/** Is this facet state the review queue? A preset is recognisable, not a separate route. */
export function isReviewQueue(facets: IndexFacets): boolean {
  return facets.statuses.length === 1 && facets.statuses[0] === 'needs_review';
}

export interface ReviewQueueView {
  readonly facets: IndexFacets;
  /** Ordered by the shared value function, so the queue and the Companion agree on what matters. */
  readonly rows: readonly IndexRow[];
  /** "with review as the default detail action". */
  readonly defaultAction: IndexAction;
  /**
   * "the empty state SAYS THAT NOTHING NEEDS ATTENTION rather than congratulating the user."
   * A key, so that the copy cannot drift into a celebration in one locale.
   */
  readonly emptyStateKey: 'review.nothingNeedsAttention';
}

export function reviewQueue(
  snapshot: GraphSnapshot,
  memory: CompanionMemory = EMPTY_MEMORY,
  nowMs: number = 0,
  facets: IndexFacets = REVIEW_QUEUE_FACETS,
): ReviewQueueView {
  const filtered = applyFacets(snapshot.entities, facets);
  const ranked = rankByValue(filtered, memory, nowMs);
  return Object.freeze({
    facets,
    rows: Object.freeze(ranked.map((r) => toRow(r.entity))),
    defaultAction: 'review',
    emptyStateKey: 'review.nothingNeedsAttention',
  });
}

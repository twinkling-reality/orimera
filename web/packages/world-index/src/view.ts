import type { GraphSnapshot } from '@orimera/graph-client';
import { openQuestionCount } from '@orimera/graph-client';
import type { CompanionMemory, OpenQuestionIndicator } from '@orimera/companion-runtime';
import { EMPTY_MEMORY, openQuestionIndicator, rankByValue } from '@orimera/companion-runtime';
import type { IndexFacets } from './facets.js';
import { ALL_FACETS, applyFacets, encodeFacets } from './facets.js';
import type { SemanticQuery } from './search.js';
import { parseSearch, semanticQuery } from './search.js';
import type { IndexRow } from './rows.js';
import { toRow } from './rows.js';
import { isReviewQueue } from './review-queue.js';

/**
 * THE WORLD INDEX (interaction-model.md 6.1).
 *
 * "Non-spatial, keyboard-first, the accessibility equivalent path (2.6), and the default entry on
 * touch devices (2.5). ... Layout is a left facet rail, a centre virtualized list and a right
 * detail pane, collapsing to list then detail on mobile."
 *
 * This module produces the state that layout renders. It is deliberately DOM-free even though
 * this package is permitted DOM: the same view model has to drive a table on desktop, a card
 * list on a phone, and a flat keyboard-navigable list for a screen reader, and the epistemic
 * rules (honest placeholders, the provenance triad, confidence only where it belongs) must be
 * identical in all three. Computing them once, here, is what guarantees that.
 *
 * VERIFIED, and the reason the keyboard list is not optional: WCAG 2.2 SC 2.1.1 (Level A)
 * requires all functionality to be keyboard operable except where the function "requires input
 * that depends on the path of the user's movement".
 * https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html
 * Free camera movement is path-dependent; none of Orimera's actual functionality is, and this
 * surface is the compliance route for all of it.
 */

export interface IndexViewInput {
  readonly snapshot: GraphSnapshot;
  /** Facet state, typically decoded from the URL. */
  readonly facets?: IndexFacets;
  /** Raw search box contents. Prefix operators are folded into the facets. */
  readonly search?: string;
  readonly memory?: CompanionMemory;
  readonly nowMs?: number;
}

export interface IndexView {
  /** The effective facets, after search operators were folded in. */
  readonly facets: IndexFacets;
  /** The linkable route state. 6.1: "a filtered state is linkable and browser navigation works." */
  readonly query: string;
  readonly rows: readonly IndexRow[];
  /** The free-text remainder, for graph-client. Null when the user typed only operators. */
  readonly semantic: SemanticQuery | null;
  readonly unknownOperators: readonly string[];
  /** The persistent HUD counter. A count, and nothing a progress ring can be built from. */
  readonly openQuestions: OpenQuestionIndicator;
  /** True when this facet state IS the review queue. A preset, not a separate screen (6.3). */
  readonly isReviewQueue: boolean;
  readonly resultCount: number;
  readonly emptyStateKey: string | null;
}

export function buildIndexView(input: IndexViewInput): IndexView {
  const parsed = parseSearch(input.search ?? '', input.facets ?? ALL_FACETS);
  const memory = input.memory ?? EMPTY_MEMORY;
  const nowMs = input.nowMs ?? 0;

  const filtered = applyFacets(input.snapshot.entities, parsed.facets);
  // One ordering everywhere: the browse list, the review queue and the Companion all agree.
  const ranked = rankByValue(filtered, memory, nowMs);
  const rows = ranked.map((r) => toRow(r.entity));
  const review = isReviewQueue(parsed.facets);

  return Object.freeze({
    facets: parsed.facets,
    query: encodeFacets(parsed.facets),
    rows: Object.freeze(rows),
    semantic: semanticQuery(parsed.text),
    unknownOperators: parsed.unknownOperators,
    openQuestions: openQuestionIndicator(openQuestionCount(input.snapshot)),
    isReviewQueue: review,
    resultCount: rows.length,
    emptyStateKey:
      rows.length > 0 ? null : review ? 'review.nothingNeedsAttention' : 'index.noMatches',
  });
}

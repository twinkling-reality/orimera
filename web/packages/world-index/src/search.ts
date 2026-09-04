import type { AssertionKind, EntityKind, IndexStatus } from '@exulanica/graph-client';
import type { IndexFacets } from './facets.js';
import { ALL_FACETS, FACET_VALUES } from './facets.js';

/**
 * SEARCH (interaction-model.md 6.1).
 *
 * "Search is ONE INPUT with prefix operators FALLING THROUGH TO SEMANTIC SEARCH."
 *
 * The operators are peeled off deterministically here; whatever is left is free text and becomes
 * a semantic query that graph-client answers. world-index does not rank and cannot: ANN lives
 * behind the graph, and "ANN is used for recall and ranking only, NEVER FOR SET MEMBERSHIP"
 * (architecture-overview.md 3), which is exactly why the facets above are applied relationally
 * and the text is not.
 */

export interface ParsedSearch {
  readonly facets: IndexFacets;
  /** What is left after the operators. Empty means "no semantic query", not "match nothing". */
  readonly text: string;
  /** Operators the user typed that do not exist. Shown as a hint, never silently ignored. */
  readonly unknownOperators: readonly string[];
}

const OPERATORS = Object.freeze({
  kind: 'kinds',
  status: 'statuses',
  in: 'islands',
  source: 'sources',
} as const);

const TOKEN = /(\w+):("[^"]*"|\S+)/g;

/**
 * Parse one search input against a base set of facets.
 *
 * Operators ADD to the facets rather than replacing them, because the facet rail and the search
 * box are two controls over one state: a user who has clicked "person" in the rail and then
 * types `in:isl-harbour-2021` means both, not the second one only.
 */
export function parseSearch(input: string, base: IndexFacets = ALL_FACETS): ParsedSearch {
  const kinds = new Set<string>(base.kinds);
  const statuses = new Set<string>(base.statuses);
  const islands = new Set<string>(base.islands);
  const sources = new Set<string>(base.sources);
  const unknown: string[] = [];

  const rest = input
    .replace(TOKEN, (match, rawKey: string, rawValue: string) => {
      const key = rawKey.toLowerCase();
      const value = rawValue.replace(/^"|"$/g, '');
      switch (OPERATORS[key as keyof typeof OPERATORS]) {
        case 'kinds':
          if ((FACET_VALUES.kinds as readonly string[]).includes(value)) kinds.add(value);
          else unknown.push(match);
          return '';
        case 'statuses': {
          // `needs-review` reads better than `needs_review` in a URL and in a search box.
          const normalized = value.replace(/-/g, '_');
          if ((FACET_VALUES.statuses as readonly string[]).includes(normalized)) {
            statuses.add(normalized);
          } else unknown.push(match);
          return '';
        }
        case 'islands':
          islands.add(value);
          return '';
        case 'sources':
          if ((FACET_VALUES.sources as readonly string[]).includes(value)) sources.add(value);
          else unknown.push(match);
          return '';
        default:
          unknown.push(match);
          return match;
      }
    })
    .replace(/\s+/g, ' ')
    .trim();

  return Object.freeze({
    facets: Object.freeze({
      kinds: Object.freeze([...kinds] as EntityKind[]),
      statuses: Object.freeze([...statuses] as IndexStatus[]),
      islands: Object.freeze([...islands]),
      sources: Object.freeze([...sources] as AssertionKind[]),
      text: rest,
    }),
    text: rest,
    unknownOperators: Object.freeze(unknown),
  });
}

/**
 * The request world-index hands to graph-client for the free-text remainder.
 *
 * It is a request object rather than a call because this package holds no transport and must
 * work with no network at all: the mobile default entry point has to render its facets and its
 * cached rows before any search resolves.
 */
export interface SemanticQuery {
  readonly text: string;
  readonly limit: number;
  /** Recall and ranking only. The caller intersects the result with the facet-filtered set. */
  readonly usedForSetMembership: false;
}

export const SEMANTIC_RESULT_LIMIT = 50;

export function semanticQuery(text: string): SemanticQuery | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return Object.freeze({
    text: trimmed,
    limit: SEMANTIC_RESULT_LIMIT,
    usedForSetMembership: false,
  });
}

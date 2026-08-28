import type {
  AssertionKind,
  EntityKind,
  EntityRecord,
  IndexStatus,
  IslandIdRef,
} from '@orimera/graph-client';
import { knowledgeSources } from '@orimera/graph-client';

/**
 * THE FOUR FACETS (interaction-model.md 6.1).
 *
 * "One entity table under four facets: Kind, Status, Presence, Source of knowledge."
 *
 * "The fourth facet DELIBERATELY REUSES THE SAME TRICHOTOMY AS THE CONFIRMATION PANEL. One
 * vocabulary everywhere, so 'what do you actually know about this' is answered identically in
 * every surface." It is spelled here as the four `AssertionKind` values rather than three,
 * because `external` is a fourth thing the user must be able to see and filter on (epi-2), and
 * hiding it behind "inferred" would collapse exactly the distinction the product sells.
 */

export interface IndexFacets {
  /** Empty means "all". An empty facet is not a filter that matches nothing. */
  readonly kinds: readonly EntityKind[];
  readonly statuses: readonly IndexStatus[];
  /** Presence: which regions. */
  readonly islands: readonly IslandIdRef[];
  /** Source of knowledge. Multi-select. */
  readonly sources: readonly AssertionKind[];
  /** The search box contents, after prefix operators have been peeled off. */
  readonly text: string;
}

export const ALL_FACETS: IndexFacets = Object.freeze({
  kinds: Object.freeze([]),
  statuses: Object.freeze([]),
  islands: Object.freeze([]),
  sources: Object.freeze([]),
  text: '',
});

const matchesAny = <T>(selected: readonly T[], value: T): boolean =>
  selected.length === 0 || selected.includes(value);

/**
 * Apply the facets. Text is NOT applied here: it is a search, not a filter, and search ranking
 * belongs to graph-client (see search.ts). Mixing them would make a semantic result set look
 * like a facet, which is how a "no results" state ends up lying about why.
 */
export function applyFacets(
  entities: readonly EntityRecord[],
  facets: IndexFacets,
): readonly EntityRecord[] {
  return entities.filter((e) => {
    if (!matchesAny(facets.kinds, e.kind)) return false;
    if (!matchesAny(facets.statuses, e.status)) return false;
    if (facets.islands.length > 0 && !facets.islands.some((i) => e.islandIds.includes(i))) {
      return false;
    }
    if (facets.sources.length > 0) {
      const sources = knowledgeSources(e);
      if (!facets.sources.some((s) => sources.includes(s))) return false;
    }
    return true;
  });
}

/**
 * URL encoding.
 *
 * 6.1: "The index is a route with URL-ENCODED FACETS, so a filtered state is linkable and
 * browser navigation works." Key order is fixed and values are sorted, so the same filter always
 * produces the same string: two users comparing links should not see different URLs for the same
 * view, and a cache key over this should not miss on ordering.
 */
const KEYS = Object.freeze(['kind', 'status', 'in', 'source', 'q'] as const);

export function encodeFacets(facets: IndexFacets): string {
  const params = new URLSearchParams();
  const push = (key: string, values: readonly string[]): void => {
    if (values.length > 0) params.set(key, [...values].sort().join(','));
  };
  push('kind', facets.kinds);
  push('status', facets.statuses);
  push('in', facets.islands);
  push('source', facets.sources);
  if (facets.text !== '') params.set('q', facets.text);
  // URLSearchParams preserves insertion order, and the pushes above follow KEYS.
  return params.toString();
}

const KIND_VALUES: readonly EntityKind[] = Object.freeze([
  'person',
  'place',
  'object',
  'event',
  'region',
]);
const STATUS_VALUES: readonly IndexStatus[] = Object.freeze([
  'confirmed',
  'needs_review',
  'inferred_only',
  'user_asserted',
  'rejected',
  'merged_away',
]);
const SOURCE_VALUES: readonly AssertionKind[] = Object.freeze([
  'user',
  'capture',
  'inference',
  'external',
]);

function pick<T extends string>(raw: string | null, allowed: readonly T[]): readonly T[] {
  if (raw === null || raw === '') return [];
  const wanted = new Set(raw.split(','));
  // Unknown values are dropped rather than throwing. A hand-edited or stale URL should degrade
  // to a broader view, not to an error page: this route is the accessibility path (2.6).
  return allowed.filter((v) => wanted.has(v));
}

export function decodeFacets(query: string): IndexFacets {
  const params = new URLSearchParams(query);
  return Object.freeze({
    kinds: pick(params.get('kind'), KIND_VALUES),
    statuses: pick(params.get('status'), STATUS_VALUES),
    islands: Object.freeze((params.get('in') ?? '').split(',').filter((s) => s !== '')),
    sources: pick(params.get('source'), SOURCE_VALUES),
    text: params.get('q') ?? '',
  });
}

export const FACET_KEYS = KEYS;
export const FACET_VALUES = Object.freeze({
  kinds: KIND_VALUES,
  statuses: STATUS_VALUES,
  sources: SOURCE_VALUES,
});

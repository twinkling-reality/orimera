/**
 * What the API sends, in the API's own words.
 *
 * Snake case, ISO 8601 strings, ids that are plain strings. These are the server's shapes and
 * they are deliberately not the read model's: a reader checking this file against the route that
 * produces it is comparing like with like, and `snapshot.ts` is then the single place where the
 * two vocabularies meet and every difference between them has to be written down.
 *
 * `toMs` lives here because reading one of these timestamps is a wire concern. The server sends a
 * string and every caller wants epoch milliseconds. A string that will not parse becomes null
 * rather than NaN, because NaN travels silently through arithmetic and comes out the far end as a
 * date, whereas a null has to be handled by whoever received it.
 */

export interface AssertionPayload {
  readonly assertion_id: string;
  readonly kind: string;
  readonly predicate_key: string;
  readonly status: string;
  readonly object_value: unknown;
  readonly support_span_ids: readonly string[];
  readonly produced_by: Readonly<Record<string, unknown>>;
  readonly asserted_at: string;
  readonly supersedes: string | null;
}

export interface HistoryPayload {
  readonly event_id: string;
  readonly event_type: string;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly undoes: string | null;
  readonly created_at: string;
}

/** What the API's `GET /graph` answers with. Server terms, not read-model terms. */
export interface GraphPayload {
  readonly state_version: number;
  readonly entities: readonly {
    readonly entity_id: string;
    readonly entity_class: string;
    readonly display_name: string | null;
    readonly merged_into: string | null;
    readonly occurrence_count: number;
    readonly capture_ids: readonly string[];
    readonly first_seen: string | null;
    readonly last_seen: string | null;
    readonly open_question_count: number;
    readonly assertions: readonly AssertionPayload[];
    readonly history: readonly HistoryPayload[];
    readonly contradictions: readonly Readonly<Record<string, unknown>>[];
  }[];
  readonly occurrences: readonly {
    readonly occurrence_id: string;
    readonly capture_id: string;
    readonly occurrence_class: string;
    readonly primary_span_id: string;
    readonly entity_id: string | null;
    readonly link_state: string | null;
    readonly captured_at: string | null;
  }[];
  readonly proposals: readonly {
    readonly proposal_id: string;
    readonly occurrence_id: string;
    readonly entity_id: string;
    readonly rank: number;
    readonly outcome: string;
    readonly basis: Readonly<Record<string, unknown>>;
    /** The modality this proposal carries that the user has not already refused for the pair. */
    readonly new_modality: string | null;
    readonly suppressed_by_rejection: boolean;
    readonly support_span_ids: readonly string[];
  }[];
  readonly scene_groups: readonly {
    readonly group_id: string;
    readonly ordinal: number;
    readonly capture_ids: readonly string[];
    readonly first_utc: string | null;
    readonly last_utc: string | null;
    readonly member_count: number;
    readonly positioned_member_count: number;
    readonly radius_m: number | null;
    readonly centroid_lat_e7: number | null;
    readonly centroid_lon_e7: number | null;
    readonly rung: number | null;
    readonly rung_capture_count: number;
  }[];
  readonly never_same: readonly (readonly [string, string])[];
  readonly deleted_entity_ids: readonly string[];
}

/** An ISO 8601 instant as epoch milliseconds, or null when it cannot be read. Never NaN. */
export function toMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

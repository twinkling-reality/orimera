/**
 * One complete `GET /graph` body, and the same body with a capture the grouping did not place.
 *
 * One home rather than a copy per test file. `snapshot.test.ts` and `islands.test.ts` both read
 * this payload and they ask different questions of it: what the adapter reports, and what an
 * island is. A second hand-written copy would be a second thing to keep in step with the server,
 * and the copy that drifts is always the one nobody is currently looking at.
 *
 * NOT typechecked. `tsconfig.json` includes `src` only, so the `GraphPayload` annotation below is
 * checked by nothing: a field the server adds can sit unwritten here until a test happens to read
 * it. That is exactly how `rung` and `rung_capture_count` came to be missing from the fixture this
 * file was extracted from. See the note in `tsconfig.json` for why the include was left alone.
 */

import type { GraphPayload } from '../src/index.js';

export const PAYLOAD: GraphPayload = {
  state_version: 7,
  entities: [
    {
      entity_id: 'e1',
      entity_class: 'person',
      display_name: 'Julie',
      merged_into: null,
      occurrence_count: 2,
      capture_ids: ['c1', 'c2'],
      first_seen: '2026-03-04T10:00:00+00:00',
      last_seen: '2026-03-04T11:00:00+00:00',
      open_question_count: 0,
      assertions: [
        {
          assertion_id: 'a1',
          kind: 'user',
          predicate_key: 'name_is',
          status: 'active',
          object_value: 'Julie',
          support_span_ids: ['s1'],
          produced_by: { by: 'user', stated_by: 'u1' },
          asserted_at: '2026-03-04T12:00:00+00:00',
          supersedes: null,
        },
      ],
      history: [
        {
          event_id: 'ev1',
          event_type: 'entity_created',
          actor: 'u1',
          payload: { entity_id: 'e1' },
          undoes: null,
          created_at: '2026-03-04T12:00:00+00:00',
        },
      ],
      contradictions: [],
    },
    {
      entity_id: 'e2',
      entity_class: 'person',
      display_name: null,
      merged_into: 'e1',
      occurrence_count: 0,
      capture_ids: [],
      first_seen: null,
      last_seen: null,
      open_question_count: 0,
      assertions: [],
      history: [],
      contradictions: [],
    },
  ],
  occurrences: [
    {
      occurrence_id: 'o1',
      capture_id: 'c1',
      occurrence_class: 'person',
      primary_span_id: 's1',
      entity_id: 'e1',
      link_state: 'confirmed',
      captured_at: '2026-03-04T10:00:00+00:00',
    },
    {
      occurrence_id: 'o2',
      capture_id: 'c2',
      occurrence_class: 'person',
      primary_span_id: 's2',
      entity_id: null,
      link_state: null,
      captured_at: null,
    },
  ],
  proposals: [],
  // c1 and c2 were clustered into one scene group. c3 was not, and that is the case that matters:
  // a photograph the clusterer could not place is still a photograph.
  scene_groups: [
    {
      group_id: 'g1',
      ordinal: 0,
      capture_ids: ['c1', 'c2'],
      first_utc: '2026-03-04T10:00:00+00:00',
      last_utc: '2026-03-04T11:00:00+00:00',
      member_count: 2,
      positioned_member_count: 2,
      radius_m: 14,
      centroid_lat_e7: 514512340,
      centroid_lon_e7: -1234560,
      rung: 2,
      rung_capture_count: 2,
    },
  ],
  never_same: [['e1', 'e2']],
  deleted_entity_ids: [],
};

/** The same payload with an ungrouped capture, for the fallback the grouping cannot cover. */
export const WITH_UNGROUPED: GraphPayload = {
  ...PAYLOAD,
  occurrences: [
    ...PAYLOAD.occurrences,
    {
      occurrence_id: 'o3',
      capture_id: 'c3',
      occurrence_class: 'object',
      primary_span_id: 's3',
      entity_id: null,
      link_state: null,
      captured_at: '2026-03-04T09:00:00+00:00',
    },
  ],
};

/** The base payload's one scene group, for a test that varies a single field of it. */
export const GROUP = PAYLOAD.scene_groups[0]!;

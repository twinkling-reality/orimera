import { describe, expect, it } from 'vitest';

import { ApiError, OrimeraClient, Transport, adaptSnapshot } from '../src/index.js';
import type { GraphPayload } from '../src/index.js';
import { ProposalGate, httpCommitTransport } from '../src/mutations/index.js';
import type { UpdateProposal } from '../src/index.js';

/** A payload shaped exactly like the one `GET /graph` answers with. */
const PAYLOAD: GraphPayload = {
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
    },
  ],
  never_same: [['e1', 'e2']],
  deleted_entity_ids: [],
};

/** The same payload with an ungrouped capture, for the fallback the grouping cannot cover. */
const WITH_UNGROUPED: GraphPayload = {
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

describe('the two zeroes that stopped being zeroes', () => {
  /** The payload above, with one pending proposal about Julie. */
  const withProposal: GraphPayload = {
    ...PAYLOAD,
    entities: PAYLOAD.entities.map((row, index) =>
      index === 0 ? { ...row, open_question_count: 1 } : row,
    ),
    proposals: [
      {
        proposal_id: 'p1',
        occurrence_id: 'o2',
        entity_id: 'e1',
        rank: 0,
        outcome: 'surfaced',
        basis: {
          modalities: ['context_cooccurrence', 'context_place'],
          extractor_versions: { context_signals: '1' },
        },
        new_modality: 'context_place',
        suppressed_by_rejection: false,
        support_span_ids: ['s2'],
      },
    ],
  };

  it('marks an entity with a pending question as needs_review, outranking its name', () => {
    // A named person with an open question is precisely what the review queue is for. Losing the
    // `user_asserted` badge while the question stands costs nothing: the provenance triad still
    // shows that a person has spoken about this entity.
    const snapshot = adaptSnapshot(withProposal);
    const julie = snapshot.entities.find((entity) => entity.entityId === 'e1');
    expect(julie?.displayName).toBe('Julie');
    expect(julie?.status).toBe('needs_review');
    expect(julie?.openQuestionCount).toBe(1);
  });

  it('keeps merged_away ahead of needs_review', () => {
    // An alias redirect is not something to review. It is somewhere else to look.
    const merged: GraphPayload = {
      ...withProposal,
      entities: withProposal.entities.map((row) =>
        row.entity_id === 'e2' ? { ...row, open_question_count: 3 } : row,
      ),
    };
    const snapshot = adaptSnapshot(merged);
    expect(snapshot.entities.find((e) => e.entityId === 'e2')?.status).toBe('merged_away');
  });

  it('bands a proposal by how many signals agree, not by its score', () => {
    // Two independent signals agreeing is a countable fact. A band read off an uncalibrated
    // weighted sum would be a guess dressed as a measurement, and no evaluation has run.
    const snapshot = adaptSnapshot(withProposal);
    const proposal = snapshot.matchProposals[0];
    expect(proposal?.basisModalities).toEqual(['context_cooccurrence', 'context_place']);
    expect(proposal?.confidence).toBe('medium');
    expect(proposal?.newModality).toBe('context_place');
  });

  it('leaves an entity with no pending question alone', () => {
    // The guard against the rule widening. Every entity in the base payload has no open
    // question, so nothing here may become needs_review.
    const snapshot = adaptSnapshot(PAYLOAD);
    expect(snapshot.entities.map((entity) => entity.status)).toEqual([
      'user_asserted',
      'merged_away',
    ]);
  });
});

describe('the snapshot adapter states what the server cannot answer', () => {
  const snapshot = adaptSnapshot(PAYLOAD, (captureId) => `island:${captureId}` as never);

  it('maps a named entity to user_asserted, because a name is a thing somebody said', () => {
    const julie = snapshot.entities[0]!;
    expect(julie.status).toBe('user_asserted');
    expect(julie.displayName).toBe('Julie');
    expect(julie.assertions[0]!.predicateKey).toBe('name_is');
    expect(julie.assertions[0]!.producedBy).toEqual({ by: 'user', statedAtMs: expect.any(Number) });
  });

  it('maps a merged entity to merged_away and keeps the redirect', () => {
    const merged = snapshot.entities[1]!;
    expect(merged.status).toBe('merged_away');
    expect(merged.mergedInto).toBe('e1');
  });

  it('carries the state version so a proposal can expire against it', () => {
    expect(snapshot.stateVersion).toBe(7);
  });

  it('leaves an unlinked occurrence as proposed rather than inventing a link', () => {
    expect(snapshot.occurrences[1]!.entityId).toBeNull();
    expect(snapshot.occurrences[1]!.linkState).toBe('proposed');
    expect(snapshot.occurrences[1]!.capturedAtMs).toBeNull();
  });

  it('asks the caller what an island is rather than deciding', () => {
    expect(snapshot.entities[0]!.islandIds).toEqual(['island:c1', 'island:c2']);
    expect(snapshot.occurrences[0]!.islandId).toBe('island:c1');
  });

  it('reports citingAnswerCount as zero because no answer is stored anywhere', () => {
    // Documented in adaptSnapshot. Asserted so the day answers ARE stored, this fails and
    // somebody has to decide rather than shipping a zero that has stopped being true.
    expect(snapshot.entities[0]!.citingAnswerCount).toBe(0);
  });
});

/**
 * ADR-0005's open question, now answered by measurement rather than left open.
 *
 * The corpus is 80 photographs across five visits, which cluster into five scene groups. One
 * island per capture is 80 islands and `solveLayout` refuses more than five. One island per
 * group is five. These tests pin the default that follows, and pin that it is still only a
 * default: the whole point of keeping the function injectable was that this stays an argument.
 */
describe('what an island is, decided by the client', () => {
  it('puts the captures of one scene group in one island', () => {
    const snapshot = adaptSnapshot(PAYLOAD);
    expect(snapshot.occurrences[0]!.islandId).toBe('g1');
    expect(snapshot.occurrences[1]!.islandId).toBe('g1');
    expect(snapshot.islands).toHaveLength(1);
    expect(snapshot.islands[0]!.captureIds).toEqual(['c1', 'c2']);
  });

  it('leaves a capture the grouping did not place standing on its own', () => {
    const snapshot = adaptSnapshot(WITH_UNGROUPED);
    expect(snapshot.occurrences[2]!.islandId).toBe('c3');
    expect(snapshot.islands.map((i) => i.islandId)).toEqual(['c3', 'g1']);
  });

  it('orders islands by when their photographs were taken, which is the layout ordering key', () => {
    const snapshot = adaptSnapshot(WITH_UNGROUPED);
    expect(snapshot.islands[0]!.firstCapturedAtMs).toBeLessThan(
      snapshot.islands[1]!.firstCapturedAtMs!,
    );
  });

  it('carries the spread only for a group whose members actually had a fix', () => {
    expect(adaptSnapshot(PAYLOAD).islands[0]!.spreadMetres).toBe(14);
    const unpositioned: GraphPayload = {
      ...PAYLOAD,
      scene_groups: [{ ...PAYLOAD.scene_groups[0]!, positioned_member_count: 0, radius_m: null }],
    };
    // Null rather than zero. A group clustered on time alone has no measured radius, and zero
    // would read as "every photograph was taken from the same spot".
    expect(adaptSnapshot(unpositioned).islands[0]!.spreadMetres).toBeNull();
  });

  it('still lets the caller decide, which is what the injection point was kept for', () => {
    const snapshot = adaptSnapshot(PAYLOAD, (captureId) => `island:${captureId}` as never);
    expect(snapshot.occurrences.map((o) => o.islandId)).toEqual(['island:c1', 'island:c2']);
  });
});

describe('the transport', () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('sends the bearer token in a header and never in the url', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const transport = new Transport({
      baseUrl: 'https://example.invalid/',
      token: 'secret-token',
      fetch: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return ok({ ok: true });
      },
    });
    await transport.getJson('/graph');
    expect(seen!.url).toBe('https://example.invalid/graph');
    expect(seen!.url).not.toContain('secret-token');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-token',
    );
  });

  it('turns a problem body into an error carrying the code, not the status', async () => {
    const transport = new Transport({
      baseUrl: 'https://example.invalid',
      token: 't',
      fetch: async () =>
        new Response(JSON.stringify({ code: 'unknown_reference', detail: 'no such evidence' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(transport.getJson('/evidence/x')).rejects.toBeInstanceOf(ApiError);
    await transport.getJson('/evidence/x').catch((error: ApiError) => {
      expect(error.code).toBe('unknown_reference');
      expect(error.isNotFound).toBe(true);
    });
  });

  it('survives a failure that is not JSON, which is what a proxy returns', async () => {
    const transport = new Transport({
      baseUrl: 'https://example.invalid',
      token: 't',
      fetch: async () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    });
    await transport.getJson('/graph').catch((error: ApiError) => {
      expect(error.status).toBe(502);
      expect(error.code).toBe('http_502');
      expect(error.message).toContain('Bad Gateway');
    });
  });

  it('reads the modality and the clock uncertainty the evidence response carries', async () => {
    const client = new OrimeraClient({
      baseUrl: 'https://example.invalid',
      token: 't',
      fetch: async () =>
        new Response(new Uint8Array([0xff, 0xd8]), {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'x-orimera-modality': 'frame_region',
            'x-orimera-captured-at': '2026-03-04T10:00:00+00:00',
            'x-orimera-captured-at-uncertainty-ms': '3600000',
          },
        }),
    });
    const [resolved] = await client.resolve(['s1' as never]);
    expect(resolved!.modality).toBe('frame_region');
    expect(resolved!.capturedAtUncertaintyMs).toBe(3_600_000);
    expect(resolved!.capturedAtMs).toBe(Date.parse('2026-03-04T10:00:00+00:00'));
  });
});

describe('the commit transport', () => {
  const proposal = (op: string, payload: Record<string, unknown>): UpdateProposal => ({
    proposalId: 'p1',
    turnId: 't1',
    origin: 'user_choice',
    rawUtterance: 'yes, the same person',
    operations: [{ op, tier: 1, affectedAnchorIds: [], affectedIslandIds: [], payload }],
    provenanceSummary: '',
    maxTier: 1,
    reversible: true,
    expiresAtStateVersion: 7,
  });

  const transportWith = (calls: string[]) =>
    new Transport({
      baseUrl: 'https://example.invalid',
      token: 't',
      fetch: async (url) => {
        calls.push(new URL(String(url)).pathname);
        return new Response(JSON.stringify({ state_version: 8, link_id: 'l1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

  it('commits an approved proposal and reads the new state version from the server', async () => {
    const calls: string[] = [];
    const gate = new ProposalGate(httpCommitTransport(transportWith(calls)), 7);
    const staged = proposal('confirm', { occurrence_id: 'o1', entity_id: 'e1' });
    gate.stage(staged);
    const result = await gate.commit('p1');
    expect(calls).toEqual(['/identity/confirm', '/graph']);
    expect(result.stateVersion).toBe(8);
    expect(gate.pendingCount).toBe(0);
  });

  it('refuses an operation it has no transport for, before sending anything', async () => {
    const calls: string[] = [];
    const gate = new ProposalGate(httpCommitTransport(transportWith(calls)), 7);
    gate.stage(proposal('teleport', {}));
    await expect(gate.commit('p1')).rejects.toThrow('has no transport');
    expect(calls).toEqual([]);
  });

  it('refuses a malformed payload before sending anything', async () => {
    const calls: string[] = [];
    const gate = new ProposalGate(httpCommitTransport(transportWith(calls)), 7);
    gate.stage(proposal('confirm', { occurrence_id: 'o1' }));
    await expect(gate.commit('p1')).rejects.toThrow('missing entity_id');
    expect(calls).toEqual([]);
  });

  it('still refuses a proposal that was never staged, which is the gate and not the transport', async () => {
    const gate = new ProposalGate(httpCommitTransport(transportWith([])), 7);
    await expect(gate.commit('never-staged')).rejects.toThrow('not in the pending set');
  });
});

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
  never_same: [['e1', 'e2']],
  deleted_entity_ids: [],
};

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

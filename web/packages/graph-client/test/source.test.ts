import { describe, expect, it, vi } from 'vitest';

import {
  loadGraph,
  OrimeraClient,
  type ApiError,
  type GraphLoadState,
  type GraphSource,
} from '../src/index.js';
import { FixtureGraphSource } from '../src/fixture.js';
import { PAYLOAD } from './graph-payload.js';

/** The consumer knows only the shared read boundary, as the experience should. */
async function readGraph(source: GraphSource) {
  return source.snapshot();
}

describe('the shared graph source', () => {
  it('gives fixture preview and HTTP transport the same read model', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify(PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const live = new OrimeraClient({
      baseUrl: 'https://orimera.invalid',
      token: 'explicit-live-token',
      fetch,
    });
    const fixture = new FixtureGraphSource(PAYLOAD);

    const fixtureStates: GraphLoadState[] = [];
    const liveStates: GraphLoadState[] = [];
    const fixtureLoaded = await loadGraph(fixture, (state) => fixtureStates.push(state));
    const liveLoaded = await loadGraph(live, (state) => liveStates.push(state));

    expect(fixtureLoaded).toEqual(liveLoaded);
    expect(fixtureStates.map((state) => state.phase)).toEqual(['loading', 'ready']);
    expect(liveStates.map((state) => state.phase)).toEqual(['loading', 'ready']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe('/graph');
  });

  it('reads a deterministic fixture without a transport or credential', async () => {
    const payload = structuredClone(PAYLOAD);
    const fixture = new FixtureGraphSource(payload);
    const first = await readGraph(fixture);

    Object.assign(payload.entities[0]!, { display_name: 'changed after construction' });

    expect(await readGraph(fixture)).toEqual(first);
  });

  it('keeps a failed live load as an error instead of substituting fixture data', async () => {
    const live = new OrimeraClient({
      baseUrl: 'https://orimera.invalid',
      token: 'explicit-live-token',
      fetch: async () =>
        new Response(JSON.stringify({ code: 'database_unavailable', detail: 'try later' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const states: GraphLoadState[] = [];
    const loaded = await loadGraph(live, (state) => states.push(state));

    expect(states.map((state) => state.phase)).toEqual(['loading', 'error']);
    expect(loaded.phase).toBe('error');
    if (loaded.phase !== 'error') throw new Error('expected a live error');
    expect(loaded.error).toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'database_unavailable',
    } satisfies Partial<ApiError>);
  });

  it('names an actually empty graph instead of treating it as a successful populated one', async () => {
    const empty = new FixtureGraphSource({
      state_version: 0,
      entities: [],
      occurrences: [],
      proposals: [],
      scene_groups: [],
      reconstruction_scenes: [],
      never_same: [],
      deleted_entity_ids: [],
    });

    expect(await loadGraph(empty)).toMatchObject({ phase: 'empty', snapshot: { stateVersion: 0 } });
  });
});

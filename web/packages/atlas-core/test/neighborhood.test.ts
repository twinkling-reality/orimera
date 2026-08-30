import { describe, expect, it } from 'vitest';
import {
  atlasVec3,
  buildNeighborhoodIndex,
  entityId,
  islandId,
  localVec3,
  makeIsland,
  makeScene,
  placement,
  type Island,
} from '../src/index.js';

function region(index: number, entities: readonly string[]): Island {
  return makeIsland({
    islandId: islandId(`region-${String(index).padStart(3, '0')}`),
    creationOrdinal: index,
    createdAt: 1_700_000_000_000 + index,
    placement: placement(atlasVec3(index * 5, 0, (index % 7) * 3), 0, 1),
    rung: 4,
    scaleIsMetric: false,
    footprintRadiusLocal: 3,
    viewpointLocal: localVec3(0, 1.6, 0),
    anchors: [],
    layoutEntities: new Set(entities.map(entityId)),
  });
}

describe('the full-library neighborhood index', () => {
  it('partitions hundreds of regions without losing or duplicating one', () => {
    const islands = Array.from({ length: 250 }, (_value, index) =>
      region(index, [`cluster-${Math.floor(index / 10)}`]),
    );
    const index = buildNeighborhoodIndex(makeScene(islands, 9, 1), { capacity: 12 });
    expect(index.neighborhoods.every((value) => value.islandIds.length <= 12)).toBe(true);
    expect(index.neighborhoodOf.size).toBe(250);
    expect(new Set(index.neighborhoods.flatMap((value) => value.islandIds)).size).toBe(250);
  });

  it('packs semantically isolated regions into bounded navigational neighborhoods', () => {
    const islands = Array.from({ length: 73 }, (_value, index) => region(index, []));
    const index = buildNeighborhoodIndex(makeScene(islands, 1, 1), { capacity: 12 });
    expect(index.neighborhoods).toHaveLength(7);
    expect(index.neighborhoods.slice(0, -1).every((value) => value.islandIds.length === 12))
      .toBe(true);
    expect(index.routes.every((route) => route.kind === 'index')).toBe(true);
  });

  it('uses confirmed entity overlap for semantic routes and labels fallback routes as index-only', () => {
    const scene = makeScene([
      region(0, ['shared']),
      region(1, ['shared']),
      region(2, ['shared']),
      region(3, ['isolated']),
      region(4, ['another-isolate']),
    ], 1, 1);
    const index = buildNeighborhoodIndex(scene, { capacity: 2 });
    expect(index.routes.some((route) => route.kind === 'semantic' && route.strength > 0)).toBe(true);
    expect(index.routes.some((route) => route.kind === 'index' && route.strength === 0)).toBe(true);
  });

  it('does not reshuffle existing unrelated neighborhoods when an unrelated region is appended', () => {
    const initial = makeScene([
      region(0, ['a']),
      region(1, ['a']),
      region(2, ['b']),
    ], 1, 1);
    const before = buildNeighborhoodIndex(initial, { capacity: 3 });
    const after = buildNeighborhoodIndex(
      makeScene([...initial.islands, region(3, ['new'])], 2, 1),
      { capacity: 3 },
    );
    for (const island of initial.islands) {
      expect(after.neighborhoodOf.get(island.islandId)).toBe(
        before.neighborhoodOf.get(island.islandId),
      );
    }
  });

  it('is invariant to scene array order because creation ordinals are authoritative', () => {
    const islands = [region(0, ['x']), region(1, ['x']), region(2, ['y'])];
    const a = buildNeighborhoodIndex(makeScene(islands, 1, 1), { capacity: 2 });
    const b = buildNeighborhoodIndex(makeScene([islands[2]!, islands[0]!, islands[1]!], 1, 1), {
      capacity: 2,
    });
    expect([...a.neighborhoodOf.entries()]).toEqual([...b.neighborhoodOf.entries()]);
    expect(a.routes).toEqual(b.routes);
  });

  it('keeps ubiquitous-entity archives sparse and bounded at 10k regions', () => {
    const islands = Array.from({ length: 10_000 }, (_value, index) =>
      region(index, ['ubiquitous']),
    );
    const started = performance.now();
    const index = buildNeighborhoodIndex(makeScene(islands, 1, 1));
    const elapsedMs = performance.now() - started;

    expect(index.neighborhoodOf.size).toBe(10_000);
    expect(index.routes).toHaveLength(index.neighborhoods.length - 1);
    expect(index.routes.every((route) => route.kind === 'index')).toBe(true);
    expect(Math.max(...index.neighborhoods.map((value) => value.adjacent.length))).toBeLessThanOrEqual(2);
    // The superseded quadratic implementation took about 17.6s on the same fixture. Keep a wide
    // regression ceiling for slower CI hosts while still detecting that failure mode.
    expect(elapsedMs).toBeLessThan(2_500);
  });
});

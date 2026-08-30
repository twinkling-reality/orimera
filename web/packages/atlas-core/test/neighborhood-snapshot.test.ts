import { describe, expect, it } from 'vitest';
import {
  AtlasNeighborhoodValidationError,
  atlasVec3,
  buildNeighborhoodIndex,
  inspectNeighborhoodCoverage,
  islandId,
  makeAtlasNeighborhoodSnapshot,
  makeIsland,
  makeScene,
  neighborhoodId,
  parseAtlasNeighborhoodSnapshot,
  placement,
  localVec3,
  snapshotNeighborhoodIndex,
} from '../src/index.js';

const membership = (id: string, ordinal: number, islands: readonly string[]) => ({
  neighborhoodId: neighborhoodId(id),
  firstCreationOrdinal: ordinal,
  islandIds: islands.map(islandId),
});

describe('durable neighborhood membership', () => {
  it('round-trips stable identity and membership in first-creation order', () => {
    const original = makeAtlasNeighborhoodSnapshot({
      neighborhoodVersion: 3,
      previousNeighborhoodVersion: 2,
      layoutVersion: 8,
      capacity: 4,
      reason: 'new-regions',
      entries: [membership('later', 7, ['c']), membership('first', 2, ['a', 'b'])],
    });
    const decoded = parseAtlasNeighborhoodSnapshot(JSON.parse(JSON.stringify(original)));
    expect(decoded.entries.map((entry) => entry.neighborhoodId)).toEqual([
      neighborhoodId('first'),
      neighborhoodId('later'),
    ]);
    expect(decoded.entries[0]!.islandIds).toEqual([islandId('a'), islandId('b')]);
  });

  it('rejects an island assigned twice and a group above capacity', () => {
    expect(() => makeAtlasNeighborhoodSnapshot({
      neighborhoodVersion: 1,
      previousNeighborhoodVersion: null,
      layoutVersion: 1,
      capacity: 2,
      reason: 'initial',
      entries: [membership('one', 0, ['a']), membership('two', 1, ['a'])],
    })).toThrow(AtlasNeighborhoodValidationError);
    expect(() => makeAtlasNeighborhoodSnapshot({
      neighborhoodVersion: 1,
      previousNeighborhoodVersion: null,
      layoutVersion: 1,
      capacity: 1,
      reason: 'initial',
      entries: [membership('one', 0, ['a', 'b'])],
    })).toThrow(/capacity/);
  });

  it('reports missing and stale membership without repairing storage', () => {
    const stored = makeAtlasNeighborhoodSnapshot({
      neighborhoodVersion: 1,
      previousNeighborhoodVersion: null,
      layoutVersion: 1,
      capacity: 3,
      reason: 'initial',
      entries: [membership('one', 0, ['a', 'old'])],
    });
    expect(inspectNeighborhoodCoverage(stored, [islandId('a'), islandId('new')])).toEqual({
      present: [islandId('a')],
      missing: [islandId('new')],
      stale: [islandId('old')],
    });
  });

  it('captures a computed index for persistence without changing its membership', () => {
    const scene = makeScene([0, 1, 2].map((ordinal) => makeIsland({
      islandId: islandId(`r${ordinal}`),
      creationOrdinal: ordinal,
      createdAt: ordinal,
      placement: placement(atlasVec3(ordinal * 5, 0, 0), 0, 1),
      rung: 4,
      scaleIsMetric: false,
      footprintRadiusLocal: 3,
      viewpointLocal: localVec3(0, 1.6, 0),
      anchors: [],
      layoutEntities: new Set(),
    })), 6, 1);
    const index = buildNeighborhoodIndex(scene, { capacity: 2 });
    const stored = snapshotNeighborhoodIndex(index, {
      neighborhoodVersion: 1,
      previousNeighborhoodVersion: null,
      reason: 'initial',
    });
    expect(stored.layoutVersion).toBe(6);
    expect(stored.entries.map((entry) => entry.islandIds)).toEqual(
      index.neighborhoods.map((entry) => entry.islandIds),
    );

    const restored = buildNeighborhoodIndex(
      makeScene([...scene.islands].reverse(), 6, 2),
      { snapshot: stored },
    );
    expect(restored.membershipVersion).toBe(1);
    expect(restored.neighborhoods.map((entry) => entry.neighborhoodId)).toEqual(
      index.neighborhoods.map((entry) => entry.neighborhoodId),
    );
    expect(restored.neighborhoods.map((entry) => entry.islandIds)).toEqual(
      index.neighborhoods.map((entry) => entry.islandIds),
    );
    expect(restored.membershipCoverage?.missing).toEqual([]);
  });

  it('refuses membership tied to a different layout version', () => {
    const stored = makeAtlasNeighborhoodSnapshot({
      neighborhoodVersion: 1,
      previousNeighborhoodVersion: null,
      layoutVersion: 2,
      capacity: 2,
      reason: 'initial',
      entries: [membership('one', 0, ['a'])],
    });
    expect(() => buildNeighborhoodIndex(makeScene([], 3, 1), { snapshot: stored }))
      .toThrow(/layoutVersion/);
  });
});

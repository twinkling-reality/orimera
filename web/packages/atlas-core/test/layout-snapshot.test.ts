import { describe, expect, it } from 'vitest';
import {
  ATLAS_LAYOUT_SCHEMA_VERSION,
  AtlasLayoutValidationError,
  atlasVec3,
  inspectLayoutCoverage,
  islandId,
  layoutCreationOrdinals,
  layoutPlacements,
  makeAtlasLayoutSnapshot,
  nextCreationOrdinal,
  parseAtlasLayoutSnapshot,
  placement,
} from '../src/index.js';

const entry = (id: string, ordinal: number) => ({
  islandId: islandId(id),
  creationOrdinal: ordinal,
  placement: placement(atlasVec3(ordinal * 10, 0.5, -ordinal), 0.25 * ordinal, 1.2),
});

describe('the persisted Atlas layout authority', () => {
  it('round-trips a JSON-safe full transform and creation ordinal', () => {
    const original = makeAtlasLayoutSnapshot({
      layoutVersion: 4,
      previousLayoutVersion: 3,
      reason: 'new-regions',
      entries: [entry('b', 2), entry('a', 1)],
    });
    const decoded = parseAtlasLayoutSnapshot(JSON.parse(JSON.stringify(original)));
    expect(decoded.schemaVersion).toBe(ATLAS_LAYOUT_SCHEMA_VERSION);
    expect(decoded.entries.map((value) => value.islandId)).toEqual(['a', 'b']);
    expect(layoutPlacements(decoded).get(islandId('b'))).toEqual(entry('b', 2).placement);
    expect(layoutCreationOrdinals(decoded).get(islandId('a'))).toBe(1);
    expect(nextCreationOrdinal(decoded)).toBe(3);
  });

  it.each([
    ['duplicate island', [entry('a', 0), entry('a', 1)]],
    ['duplicate ordinal', [entry('a', 0), entry('b', 0)]],
  ])('rejects %s instead of choosing an authority by accident', (_label, entries) => {
    expect(() => makeAtlasLayoutSnapshot({
      layoutVersion: 1,
      previousLayoutVersion: null,
      reason: 'initial',
      entries,
    })).toThrow(AtlasLayoutValidationError);
  });

  it('rejects invalid versions and non-finite or non-positive transforms', () => {
    expect(() => parseAtlasLayoutSnapshot({
      schemaVersion: 1,
      layoutVersion: 2,
      previousLayoutVersion: 2,
      reason: 'migration',
      entries: [],
    })).toThrow(/lower/);
    expect(() => parseAtlasLayoutSnapshot({
      schemaVersion: 1,
      layoutVersion: 1,
      previousLayoutVersion: null,
      reason: 'initial',
      entries: [{
        islandId: 'a',
        creationOrdinal: 0,
        placement: { position: { x: 0, y: 0, z: 0 }, yaw: Number.NaN, scale: 0 },
      }],
    })).toThrow(AtlasLayoutValidationError);
  });

  it('reports missing and stale records without silently repairing them', () => {
    const snapshot = makeAtlasLayoutSnapshot({
      layoutVersion: 1,
      previousLayoutVersion: null,
      reason: 'initial',
      entries: [entry('a', 0), entry('old', 1)],
    });
    expect(inspectLayoutCoverage(snapshot, [islandId('a'), islandId('new')])).toEqual({
      present: [islandId('a')],
      missing: [islandId('new')],
      stale: [islandId('old')],
    });
  });
});

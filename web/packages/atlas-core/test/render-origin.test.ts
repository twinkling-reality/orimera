import { describe, expect, it } from 'vitest';
import {
  atlasVec3,
  buildNeighborhoodIndex,
  islandId,
  localVec3,
  makeIsland,
  makeScene,
  placement,
  renderOriginForNeighborhood,
} from '../src/index.js';

const island = (id: string, x: number, ordinal: number) => makeIsland({
  islandId: islandId(id), creationOrdinal: ordinal, createdAt: ordinal,
  placement: placement(atlasVec3(x, 0, x / 2), 0, 1),
  rung: 4, scaleIsMetric: false, footprintRadiusLocal: 3,
  viewpointLocal: localVec3(0, 1.6, 0), anchors: [], layoutEntities: new Set(),
});

describe('neighborhood render origin', () => {
  it('keeps canonical positions untouched while bounding GPU-relative magnitudes', () => {
    const scene = makeScene([island('a', 100_000, 0), island('b', 100_040, 1)], 1, 1);
    const neighborhoods = buildNeighborhoodIndex(scene, { capacity: 2 });
    const active = neighborhoods.neighborhoods[0]!.neighborhoodId;
    const selected = renderOriginForNeighborhood(scene, neighborhoods, active);
    expect(Math.abs(scene.islands[0]!.placement.position.x - selected.origin.x)).toBeLessThan(64);
    expect(scene.islands[0]!.placement.position.x).toBe(100_000);
    expect(selected.origin.x % 64).toBe(0);
  });

  it('is stable inside one neighborhood and rejects an unknown identity', () => {
    const scene = makeScene([island('a', 10, 0)], 1, 1);
    const neighborhoods = buildNeighborhoodIndex(scene);
    const active = neighborhoods.neighborhoods[0]!.neighborhoodId;
    const selected = renderOriginForNeighborhood(scene, neighborhoods, active);
    expect(renderOriginForNeighborhood(scene, neighborhoods, active, selected)).toBe(selected);
    expect(() => renderOriginForNeighborhood(
      scene, neighborhoods, 'neighborhood:missing' as never, selected,
    )).toThrow(/unknown render-origin neighborhood/);
  });
});

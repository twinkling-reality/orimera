import { describe, expect, it } from 'vitest';
import { atlasVec3, localToAtlas, localVec3, placement } from '@orimera/atlas-core';
import type { Island } from '@orimera/atlas-core';
import { islandId, makeIsland } from '@orimera/atlas-core';
import type { PointMapData, OpmHeader } from '../src/opm.js';
import { atlasGroundToIslandGrid, buildOccupancyGrid, sampleGround } from '../src/containment.js';

/**
 * The inverse-transform test is the important one in this file.
 *
 * atlas-core deliberately exports no `atlasToLocal`, and it is right not to: going back would
 * let a caller launder a presentational position into an answer about the world. The renderer
 * still has to know which grid cell the camera stands over, so `atlasGroundToIslandGrid` exists
 * and is restricted to raw numbers on the ground plane. Being the only inverse in the codebase,
 * it is also the only place a sign error would be invisible: it would not throw, it would just
 * put the walker on the wrong part of the floor, in a way nobody would notice until the camera
 * clipped through a wall on a scene nobody was watching.
 */

const island = (yaw: number, scale: number, x: number, z: number): Island =>
  makeIsland({
    islandId: islandId('t'),
    createdAt: 0,
    placement: placement(atlasVec3(x, 0, z), yaw, scale),
    rung: 3,
    scaleIsMetric: true,
    footprintRadiusLocal: 40,
    viewpointLocal: localVec3(0, 1.55, 0),
    anchors: [],
    layoutEntities: new Set(),
  });

describe('atlasGroundToIslandGrid', () => {
  it('inverts localToAtlas exactly on the ground plane, for every placement', () => {
    for (const yaw of [0, 0.4, 1.1853, -2.2, Math.PI]) {
      for (const scale of [1, 0.6, 2.5]) {
        const i = island(yaw, scale, 107.3, -19.2);
        for (const [lx, lz] of [
          [0, 0],
          [3, -17],
          [-22.5, 41.25],
        ] as const) {
          const a = localToAtlas(i.placement, localVec3(lx, 0, lz));
          const back = atlasGroundToIslandGrid(i, a.x, a.z);
          expect(back.x).toBeCloseTo(lx, 6);
          expect(back.z).toBeCloseTo(lz, 6);
        }
      }
    }
  });
});

function synthetic(): PointMapData {
  // A 4 m square of quay at y = 0, a 4 m square of water at x > 0, and one unobserved quadrant.
  const pts: number[] = [];
  const segs: number[] = [];
  const push = (x: number, y: number, z: number, s: number): void => {
    pts.push(x, y, z);
    segs.push(s);
  };
  // Dense enough that a 0.125 m grid cell clears MIN_SUPPORT. A real 4M point map clears it
  // everywhere it observed anything; a toy fixture has to be built to.
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const x = -8 + (i / N) * 8;
      const z = -8 + (j / N) * 8;
      push(x, 0, z, 0); // quay, supporting
      push(-x, 0, z, 1); // water, blocking (mirrored into +x)
    }
  }
  // A wall: a dense column of structure points in the body band at (-4, -4).
  for (let k = 0; k < 60; k += 1) push(-4, 0.5 + k * 0.02, -4, 2);

  const header = {
    format: 'orimera-point-map',
    version: 2,
    pointCount: segs.length,
    rung: 3,
    metric: true,
    viewpoint: { position: [0, 1.55, 0], forward: [0, 0, -1], fovYDeg: 55 },
    sourceImage: { width: 100, height: 100 },
    modelImage: { width: 100, height: 100 },
    bounds: { min: [-8, 0, -8], max: [8, 2, 8] },
    colorAlpha: 'confidence',
    segments: [
      { id: 0, name: 'quay', cls: 'ground' },
      { id: 1, name: 'water', cls: 'water' },
      { id: 2, name: 'facade', cls: 'structure' },
    ],
    sections: [],
    statistics: {},
  } as unknown as OpmHeader;

  return {
    header,
    position: new Float32Array(pts),
    color: new Uint8Array(segs.length * 4).fill(255),
    // Two channels per point since OPM/2: the segment id, then a flags word this double leaves
    // at zero because nothing here has a silhouette to drop.
    tags: new Uint16Array(segs.flatMap((id) => [id, 0])),
    byteLength: 0,
  };
}

describe('buildOccupancyGrid', () => {
  const grid = buildOccupancyGrid(synthetic(), 10);

  it('finds a floor under supporting ground', () => {
    const s = sampleGround(grid, -4, -2);
    expect(s.floorY).not.toBeNull();
    expect(s.passable).toBe(true);
  });

  it('refuses water outright, so the user cannot walk into the harbour', () => {
    const s = sampleGround(grid, 4, -2);
    expect(s.passable).toBe(false);
    expect(s.floorY).toBeNull();
  });

  it('refuses an unobserved column rather than dropping the walker through it', () => {
    // Nothing was written near (-9.5, 9.5). Unobserved is not the same as empty: the camera
    // never saw what is there, so the honest answer is a refusal, not a floor at zero.
    const s = sampleGround(grid, -9.5, 9.5);
    expect(s.floorY).toBeNull();
    expect(s.passable).toBe(false);
  });

  it('marks a dense body-band column impassable', () => {
    const s = sampleGround(grid, -4, -4);
    expect(s.passable).toBe(false);
  });
});

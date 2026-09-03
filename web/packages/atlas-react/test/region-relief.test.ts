import { describe, expect, it } from 'vitest';
import { sampleRelief } from '../src/playcanvas/region-relief.js';
import type { PointMap } from '../src/playcanvas/opm.js';

/**
 * The Map's relief, at the one place it makes a claim: which cells of a region were observed.
 *
 * The mesh building needs a GraphicsDevice and is left to the browser. What is worth asserting
 * here is the binning, because it is where "the region has a surface here" is decided, and
 * getting it wrong produces a Map that looks plausible and describes ground nobody photographed.
 */

/** A point map on a grid at a chosen depth, with a chosen support written into the alpha. */
function map(options: {
  readonly cols: number;
  readonly rows: number;
  readonly z0: number;
  readonly z1: number;
  readonly support: number;
  readonly height?: (col: number, row: number) => number;
  /** Points this returns true for are written with no support, so they drop out as holes. */
  readonly unsupported?: (col: number, row: number) => boolean;
}): PointMap {
  const { cols, rows, z0, z1, support } = options;
  const count = cols * rows;
  const position = new Float32Array(count * 3);
  const color = new Uint8Array(count * 4);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const i = row * cols + col;
      position[i * 3] = col;
      position[i * 3 + 1] = options.height?.(col, row) ?? 0;
      position[i * 3 + 2] = z0 + ((z1 - z0) * row) / Math.max(1, rows - 1);
      color[i * 4] = 200;
      color[i * 4 + 1] = 100;
      color[i * 4 + 2] = 50;
      const held = options.unsupported?.(col, row) === true ? 0 : support;
      color[i * 4 + 3] = Math.round(held * 255);
    }
  }
  return {
    header: {
      format: 'orimera-point-map',
      version: 1,
      pointCount: count,
      rung: 3,
      frame: 'local',
      up: '+Y',
      forward: '-Z',
      units: 'metres',
      metric: true,
      viewpoint: {
        position: [0, 0, 0],
        forward: [0, 0, -1],
        up: [0, 1, 0],
        fovYDeg: 55,
        aspect: 4 / 3,
      },
      sourceImage: { width: cols, height: rows },
      bounds: { min: [0, 0, Math.min(z0, z1)], max: [cols - 1, 1, Math.max(z0, z1)] },
      colorAlpha: 'confidence',
      segments: [{ id: 0, name: 'unsegmented', cls: 'structure' }],
      sections: [],
    },
    buffer: new ArrayBuffer(0),
    position,
    color,
    segment: new Uint16Array(count),
    planarContiguous: true,
    packedByteOffset: 0,
    packedByteLength: 0,
  };
}

describe('the relief a region shows on the Map', () => {
  it('bins over the extent the geometry occupies, not a disc around the origin', () => {
    // Every point is in front of the camera, so z is entirely negative. A grid centred on the
    // origin would put the whole region in a corner of its own cells.
    const { cells, ok, grid } = sampleRelief(map({
      cols: 160, rows: 160, z0: -30, z1: -3, support: 1,
    }));
    expect(ok).toBe(true);
    const filled = cells.filter((c) => c !== null).length;
    expect(filled).toBeGreaterThan(grid);
  });

  it('leaves an unobserved cell empty rather than filling it with a zero height', () => {
    const { cells } = sampleRelief(map({
      cols: 160,
      rows: 160,
      z0: -20,
      z1: -4,
      support: 1,
      // A band across the middle that the capture never resolved.
      unsupported: (_col, row) => row > 60 && row < 100,
    }));
    // The band must arrive as holes rather than as flat ground, because a zero-height cell is a
    // claim that the surface was seen and found level.
    expect(cells.some((c) => c === null)).toBe(true);
    expect(cells.some((c) => c !== null)).toBe(true);
  });

  it('drops points the map itself marked as barely sampled', () => {
    // The sky and the grazing pavement arrive with low support, and a plateau built from them
    // would be the Map asserting terrain out of the least reliable thing in the file.
    const thin = sampleRelief(map({ cols: 160, rows: 160, z0: -30, z1: -3, support: 0.1 }));
    const solid = sampleRelief(map({ cols: 160, rows: 160, z0: -30, z1: -3, support: 1 }));
    expect(thin.cells.every((c) => c === null)).toBe(true);
    expect(solid.cells.some((c) => c !== null)).toBe(true);
  });

  it('carries the mean height and the mean support of the samples in a cell', () => {
    const { cells } = sampleRelief(map({
      cols: 160, rows: 160, z0: -30, z1: -3, support: 0.5, height: () => 4,
    }));
    const cell = cells.find((c) => c !== null)!;
    expect(cell.height).toBeCloseTo(4, 5);
    expect(cell.support).toBeCloseTo(0.5, 2);
  });

  it('reports nothing for a map with no extent rather than dividing by zero', () => {
    const flat = map({ cols: 4, rows: 4, z0: -5, z1: -5, support: 1 });
    const degenerate: PointMap = {
      ...flat,
      header: { ...flat.header, bounds: { min: [0, 0, -5], max: [0, 0, -5] } },
    };
    const { ok, cells } = sampleRelief(degenerate);
    expect(ok).toBe(false);
    expect(cells.every((c) => c === null)).toBe(true);
  });
});

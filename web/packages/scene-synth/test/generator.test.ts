import { describe, expect, it } from 'vitest';
import { decodeOpm, encodeOpm } from '../src/format/opm.js';
import { DEFAULT_GENERATE, POINT_LADDER, generatePointMap } from '../src/generate.js';
import { buildFixtureScene } from '../src/island-fixture.js';
import { SEGMENTS } from '../src/scene.js';
import { buildAnchorTable, islandRung } from '@orimera/atlas-core';

/**
 * The generator's contract with ADR-0003.
 *
 * Two renderer bindings measured on two different point clouds have not been compared, so
 * determinism and exact counts are correctness properties here, not niceties.
 */

const TARGET = 40_000;
const run = (target = TARGET, seed = DEFAULT_GENERATE.seed) =>
  generatePointMap({ targetPoints: target, seed });

describe('the generator is deterministic and exact', () => {
  it('produces byte-identical buffers for the same seed', () => {
    const a = run();
    const b = run();
    expect(a.points.count).toBe(b.points.count);
    expect(Array.from(a.points.position)).toEqual(Array.from(b.points.position));
    expect(Array.from(a.points.color)).toEqual(Array.from(b.points.color));
    expect(Array.from(a.points.segment)).toEqual(Array.from(b.points.segment));
    expect(a.sourceWidth).toBe(b.sourceWidth);
  });

  it('produces a different world for a different seed', () => {
    const a = run(TARGET, 1);
    const b = run(TARGET, 2);
    expect(Array.from(a.points.color)).not.toEqual(Array.from(b.points.color));
  });

  it('hits the requested point count exactly', () => {
    for (const target of [10_000, 40_000, 137_777]) {
      const r = run(target);
      expect(r.points.count).toBe(target);
      expect(r.points.position.length).toBe(target * 3);
      expect(r.points.color.length).toBe(target * 4);
      expect(r.points.segment.length).toBe(target);
    }
  });

  it('offers the bake-off ladder ADR-0003 asks for', () => {
    expect(POINT_LADDER).toEqual([250_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000]);
  });

  it('uses no ambient randomness', () => {
    const real = Math.random;
    Math.random = () => {
      throw new Error('the generator must not call Math.random');
    };
    try {
      expect(() => run(10_000)).not.toThrow();
    } finally {
      Math.random = real;
    }
  });
});

describe('the output is a 2.5D shell, not a cloud in a box', () => {
  const r = run();

  it('never invents geometry the camera did not see', () => {
    // Every point must reproject inside the source image and in front of the viewpoint. A point
    // that fails this came from nowhere.
    const { width, height } = r.meta.sourceImage;
    const focal = height / 2 / Math.tan((r.meta.viewpoint.fovYDeg * Math.PI) / 360);
    const eye = r.meta.viewpoint.position;
    let outside = 0;
    let behind = 0;
    for (let i = 0; i < r.points.count; i += 1) {
      const d = eye[2] - r.points.position[i * 3 + 2]!;
      if (d <= 0) {
        behind += 1;
        continue;
      }
      const px = width / 2 + (focal * (r.points.position[i * 3]! - eye[0])) / d;
      const py = height / 2 - (focal * (r.points.position[i * 3 + 1]! - eye[1])) / d;
      if (px < -1 || py < -1 || px > width + 1 || py > height + 1) outside += 1;
    }
    expect(behind).toBe(0);
    expect(outside).toBe(0);
  });

  it('leaves a large honest hole where nothing was observed', () => {
    const s = r.meta.statistics;
    // Sky and everything beyond the frustum. This is the biggest hole in any real point map.
    expect(s.pixelsUnobserved! / s.sourcePixels!).toBeGreaterThan(0.15);
  });

  it('carves the far side of every occlusion boundary', () => {
    expect(r.meta.statistics.pixelsCarvedAtOcclusionBoundaries!).toBeGreaterThan(0);
  });

  it('has point density falling off with depth, the way perspective forces', () => {
    const eye = r.meta.viewpoint.position;
    let near = 0;
    let far = 0;
    for (let i = 0; i < r.points.count; i += 1) {
      const d = eye[2] - r.points.position[i * 3 + 2]!;
      if (d < 10) near += 1;
      else if (d > 20) far += 1;
    }
    // Uniform noise in a box would put more points far away, because there is more volume there.
    // A point map does the opposite, and that difference is what the bake-off is sensitive to.
    expect(near).toBeGreaterThan(far * 3);
  });

  it('thins surfaces unevenly, because the reasons for thinning are physical', () => {
    const perSegment = new Map<number, number>();
    for (let i = 0; i < r.points.count; i += 1) {
      const s = r.points.segment[i]!;
      perSegment.set(s, (perSegment.get(s) ?? 0) + 1);
    }
    // Several distinct segments must be present, and the distribution must not be flat.
    expect(perSegment.size).toBeGreaterThanOrEqual(8);
    const shares = [...perSegment.values()].map((v) => v / r.points.count).sort((a, b) => b - a);
    expect(shares[0]!).toBeGreaterThan(0.15);
    expect(shares[shares.length - 1]!).toBeLessThan(0.01);
  });

  it('carries per-point confidence that varies with observation quality', () => {
    let min = 255;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < r.points.count; i += 1) {
      const c = r.points.color[i * 4 + 3]!;
      if (c < min) min = c;
      if (c > max) max = c;
      sum += c;
    }
    expect(min).toBeLessThan(64);
    expect(max).toBeGreaterThan(200);
    const mean = sum / r.points.count;
    expect(mean).toBeGreaterThan(100);
    expect(mean).toBeLessThan(250);
  });

  it('labels every point with a segment id from the declared table', () => {
    const known = new Set(SEGMENTS.map((s) => s.id));
    for (let i = 0; i < r.points.count; i += 1) expect(known.has(r.points.segment[i]!)).toBe(true);
  });
});

describe('the ladder is one place at several resolutions', () => {
  it('keeps the valid-pixel fraction stable across rungs', () => {
    const small = run(20_000);
    const large = run(200_000);
    expect(large.sourceWidth).toBeGreaterThan(small.sourceWidth * 2);
    expect(Math.abs(large.validFraction - small.validFraction)).toBeLessThan(0.05);
  });
});

describe('the .opm container', () => {
  const r = run(20_000);
  const encoded = encodeOpm(r.points, r.meta);
  const decoded = decodeOpm(
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
  );

  it('round-trips every buffer exactly', () => {
    expect(decoded.header.pointCount).toBe(r.points.count);
    expect(Array.from(decoded.position)).toEqual(Array.from(r.points.position));
    expect(Array.from(decoded.color)).toEqual(Array.from(r.points.color));
    expect(Array.from(decoded.segment)).toEqual(Array.from(r.points.segment));
  });

  it('aligns every section to 16 bytes, so both engines get zero-copy views', () => {
    for (const s of decoded.header.sections) expect(s.byteOffset % 16).toBe(0);
  });

  it('costs exactly 18 bytes per point plus the header', () => {
    const payload = decoded.header.sections.reduce((n, s) => n + s.byteLength, 0);
    expect(payload).toBe(r.points.count * 18);
  });

  it('states the viewpoint, the rung and what the alpha channel means', () => {
    expect(decoded.header.rung).toBe(3);
    expect(decoded.header.colorAlpha).toBe('confidence');
    expect(decoded.header.forward).toBe('-Z');
    expect(decoded.header.up).toBe('+Y');
    expect(decoded.header.units).toBe('metres');
    expect(decoded.header.viewpoint.position).toEqual([0, 1.55, 0]);
  });

  it('rejects bytes that are not an .opm', () => {
    expect(() => decodeOpm(new ArrayBuffer(64))).toThrow(/not an .opm file/);
  });
});

describe('the fixture is a real island, not just a point cloud', () => {
  const scene = buildFixtureScene(3);

  it('lays three islands out with the real solver', () => {
    expect(scene.islands).toHaveLength(3);
    const positions = scene.islands.map((i) => `${i.placement.position.x},${i.placement.position.z}`);
    expect(new Set(positions).size).toBe(3);
  });

  it('declares rung 3, which is what a single photograph earns', () => {
    for (const i of scene.islands) {
      expect(i.rung).toBe(3);
      expect(islandRung(i).movement).toBe('panels');
      expect(islandRung(i).impliesFreeMovement).toBe(false);
    }
  });

  it('spans the epistemic states the overlay has to distinguish', () => {
    const table = buildAnchorTable(scene);
    const states = new Set(table.anchors.map((a) => a.linkState));
    const provenances = new Set(table.anchors.map((a) => a.provenance));
    expect(states).toEqual(new Set(['confirmed', 'auto_provisional', 'proposed']));
    expect(provenances).toEqual(new Set(['user', 'inference', 'capture']));
    expect(table.count).toBe(18);
  });

  it('gives each island one contiguous run of anchor indices, for one instanced mesh each', () => {
    const table = buildAnchorTable(scene);
    let expected = 0;
    for (const id of table.islandIds) {
      const [start, count] = table.islandRange.get(id)!;
      expect(start).toBe(expected);
      expected += count;
    }
    expect(expected).toBe(table.count);
  });
});

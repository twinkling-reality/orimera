import { describe, expect, it } from 'vitest';
import { PACKED_STRIDE_BYTES, TAG_ONE_SIDED, decodeOpm, encodeOpm } from '../src/format/opm.js';
import { DEFAULT_GENERATE, POINT_LADDER, generatePointMap } from '../src/generate.js';
import { buildFixtureScene } from '../src/island-fixture.js';
import { SEGMENTS } from '../src/scene.js';
import { buildAnchorTable, islandRung } from '@exulanica/atlas-core';

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
    expect(Array.from(a.points.tags)).toEqual(Array.from(b.points.tags));
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
      expect(r.points.tags.length).toBe(target * 2);
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
      const s = r.points.tags[i * 2]!;
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
    for (let i = 0; i < r.points.count; i += 1) expect(known.has(r.points.tags[i * 2]!)).toBe(true);
  });

  it('marks the points beside a carved occlusion boundary, and only those', () => {
    // ADR-0010 D4's bit 0. The count is the interesting assertion rather than the mechanism: a
    // writer that marked everything or nothing would satisfy "the channel exists", and both are
    // the failure the flag exists to avoid. Carving happens at depth cliffs, which this scene
    // has and which the honesty model's own statistics count, so a share of the points is
    // marked and it is a minority.
    let marked = 0;
    const flags = new Set<number>();
    for (let i = 0; i < r.points.count; i += 1) {
      const word = r.points.tags[i * 2 + 1]!;
      flags.add(word);
      if (word & TAG_ONE_SIDED) marked += 1;
    }
    // Nothing but bit 0 is ever set, which is what the production validator checks for.
    expect([...flags].sort()).toEqual([0, TAG_ONE_SIDED]);
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(r.points.count / 2);
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
    expect(Array.from(decoded.tags)).toEqual(Array.from(r.points.tags));
  });

  it('aligns the first section and packs the rest behind it, back to back', () => {
    // CHANGED BY ADR-0010, which supersedes this writer's per-section sixteen-byte alignment by
    // name. PlayCanvas computes its own tightly packed planar offsets, so a gap anywhere cost a
    // per-point CPU repack. What has to hold is that the first section is aligned, that nothing
    // sits between them, and that every section still starts where a typed-array view may.
    //
    // THIS COUNT CANNOT SEE THE DEFECT ON ITS OWN, and the test below is the one that can. At
    // twenty thousand points every section length is already a multiple of sixteen, so aligning
    // each section and packing them tightly produce the same file: ADR-0010's "contiguous only
    // when the point count happened to be a multiple of four" is exactly this blind spot. The
    // assertion is kept because it is a real fixture at a real ladder count; it is not the one
    // standing between this writer and the old layout.
    const sections = decoded.header.sections;
    expect(sections[0]!.byteOffset % 16).toBe(0);
    for (const [index, section] of sections.entries()) {
      if (index === 0) continue;
      const previous = sections[index - 1]!;
      expect(section.byteOffset).toBe(previous.byteOffset + previous.byteLength);
    }
    expect(sections.find((s) => s.name === 'position')!.byteOffset % 4).toBe(0);
    expect(sections.find((s) => s.name === 'tags')!.byteOffset % 2).toBe(0);
  });

  it('stays contiguous at a point count that is not a multiple of four', () => {
    // FIVE POINTS, AND THE NUMBER IS THE TEST. Sixty bytes of position, twenty of colour and
    // twenty of tags: none of the three is a multiple of sixteen, so a writer that aligned each
    // section would leave four bytes of padding in front of the colour section and the file
    // would fall off the renderer's zero-copy path. That is what the production validator was
    // refusing these files for, and it is why ADR-0010 names the old alignment as superseded.
    //
    // Encoded from a hand-built map rather than from the generator, because the generator hits
    // exact counts on the bake-off ladder and every one of those is a multiple of four.
    const five = encodeOpm(
      {
        count: 5,
        position: new Float32Array(15),
        color: new Uint8Array(20),
        tags: new Uint16Array(10),
        min: [0, 0, -1] as const,
        max: [0, 0, -1] as const,
      },
      r.meta,
    );
    const buffer = five.buffer.slice(five.byteOffset, five.byteOffset + five.byteLength);
    const sections = decodeOpm(buffer as ArrayBuffer).header.sections;
    expect(sections.map((s) => s.byteLength)).toEqual([60, 20, 20]);
    expect(sections[0]!.byteOffset % 16).toBe(0);
    for (const [index, section] of sections.entries()) {
      if (index === 0) continue;
      const previous = sections[index - 1]!;
      expect(section.byteOffset).toBe(previous.byteOffset + previous.byteLength);
    }
    // Still legal views: float32 needs a multiple of four and uint16 a multiple of two.
    expect(sections[0]!.byteOffset % 4).toBe(0);
    expect(sections[2]!.byteOffset % 2).toBe(0);
  });

  it('costs exactly 20 bytes per point plus the header', () => {
    // Eighteen under OPM/1. The two extra bytes are the tags section's flags channel, which the
    // WebGPU binding was already paying for per point on the CPU.
    const payload = decoded.header.sections.reduce((n, s) => n + s.byteLength, 0);
    expect(PACKED_STRIDE_BYTES).toBe(20);
    expect(payload).toBe(r.points.count * PACKED_STRIDE_BYTES);
  });

  it('refuses an OPM/1 container by name rather than reading it as this version', () => {
    // ADR-0010 D9 is refuse and regenerate. This decoder is the reference one, so it has to
    // refuse an old file as loudly as the production validator does, and name what makes a new
    // one: for this generator's fixtures that is `pnpm synth`.
    const one = encoded.slice();
    const view = new DataView(one.buffer, one.byteOffset, one.byteLength);
    const headerLength = view.getUint32(4, true);
    const text = new TextDecoder().decode(one.subarray(8, 8 + headerLength));
    const downgraded = new TextEncoder().encode(text.replace('"version":2', '"version":1'));
    expect(downgraded.length).toBe(headerLength);
    one.set(downgraded, 8);
    const buffer = one.buffer.slice(one.byteOffset, one.byteOffset + one.byteLength) as ArrayBuffer;
    expect(() => decodeOpm(buffer)).toThrow(/OPM\/1/);
    expect(() => decodeOpm(buffer)).toThrow(/pnpm synth/);
  });

  it('states the viewpoint, the rung and what the alpha channel means', () => {
    expect(decoded.header.rung).toBe(3);
    expect(decoded.header.version).toBe(2);
    // A belief, from the honesty model, and declared as such. The other legal value is
    // `support`, which is what the reconstruction path writes.
    expect(decoded.header.colorAlpha).toBe('confidence');
    // Both grids, per ADR-0010 D6. This generator rasterises at the resolution it reports, so
    // they are equal; what matters is that the file states it rather than leaving it inferable.
    expect(decoded.header.modelImage).toEqual(decoded.header.sourceImage);
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

import { describe, expect, it } from 'vitest';
import {
  decodeOpm,
  footprintRadiusOf,
  packedVertexBytes,
  sourcePanelEnvelopeOf,
} from '../src/playcanvas/opm.js';
import type { OpmHeader } from '../src/playcanvas/opm.js';

/**
 * These tests cover the loader only. They deliberately import nothing from `playcanvas`, because
 * the engine touches browser globals at module scope and these run under vitest's node
 * environment; the binding itself is covered by the bake-off page, which is the only place a GPU
 * exists.
 *
 * What is worth asserting here is the CONTIGUITY CONTRACT. PlayCanvas holds one VertexBuffer per
 * Mesh and computes its own tightly packed planar offsets, so the loader can only avoid a
 * per-point CPU pass when the file's three sections sit back to back. That is a property of the
 * container, it holds for every count on the bake-off ladder, and a change to `scene-synth` could
 * silently break it into a copy nobody notices.
 */

const align = (n: number): number => Math.ceil(n / 16) * 16;

interface BuildOptions {
  readonly count: number;
  /** Extra bytes of padding inserted before the colour and segment sections. */
  readonly gap?: number;
}

function buildOpm({ count, gap = 0 }: BuildOptions): ArrayBuffer {
  const sizes = { position: count * 12, color: count * 4, segment: count * 2 };

  const header = (offsets: [number, number, number]): OpmHeader =>
    ({
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
        position: [0, 1.55, 0],
        forward: [0, 0, -1],
        up: [0, 1, 0],
        fovYDeg: 55,
        aspect: 4 / 3,
      },
      sourceImage: { width: 400, height: 300 },
      bounds: { min: [-3, 0, -8], max: [4, 2, -1] },
      colorAlpha: 'confidence',
      segments: [
        { id: 0, name: 'quay', cls: 'ground' },
        { id: 1, name: 'water', cls: 'water' },
      ],
      sections: [
        {
          name: 'position',
          type: 'float32',
          components: 3,
          normalized: false,
          byteOffset: offsets[0],
          byteLength: sizes.position,
        },
        {
          name: 'color',
          type: 'uint8',
          components: 4,
          normalized: true,
          byteOffset: offsets[1],
          byteLength: sizes.color,
        },
        {
          name: 'segment',
          type: 'uint16',
          components: 1,
          normalized: false,
          byteOffset: offsets[2],
          byteLength: sizes.segment,
        },
      ],
    }) satisfies OpmHeader;

  const probe = new TextEncoder().encode(JSON.stringify(header([0, 0, 0])));
  const capacity = align(probe.length + 96);
  const dataStart = 8 + capacity;

  const positionAt = align(dataStart);
  const colorAt = align(positionAt + sizes.position) + gap;
  const segmentAt = align(colorAt + sizes.color) + gap;
  const total = align(segmentAt + sizes.segment);

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const headerBytes = new TextEncoder().encode(
    JSON.stringify(header([positionAt, colorAt, segmentAt])),
  );
  bytes.set(new TextEncoder().encode('OPM1'), 0);
  view.setUint32(4, headerBytes.length, true);
  bytes.set(headerBytes, 8);

  for (let i = 0; i < count; i += 1) {
    view.setFloat32(positionAt + i * 12, i, true);
    view.setFloat32(positionAt + i * 12 + 4, i + 0.5, true);
    view.setFloat32(positionAt + i * 12 + 8, -i, true);
    bytes[colorAt + i * 4] = i & 0xff;
    bytes[colorAt + i * 4 + 3] = 200;
    view.setUint16(segmentAt + i * 2, i % 2, true);
  }
  return bytes.buffer;
}

describe('the .opm loader', () => {
  it('reads the header and exposes zero-copy views over the same buffer', () => {
    const buffer = buildOpm({ count: 8 });
    const map = decodeOpm(buffer);

    expect(map.header.pointCount).toBe(8);
    expect(map.header.rung).toBe(3);
    // The alpha channel is confidence, not opacity, and the file says so rather than the reader
    // assuming it.
    expect(map.header.colorAlpha).toBe('confidence');

    expect(map.position.buffer).toBe(buffer);
    expect(map.color.buffer).toBe(buffer);
    expect(map.segment.buffer).toBe(buffer);

    expect(map.position[3]).toBeCloseTo(1);
    expect(map.color[3]).toBe(200);
    expect(map.segment[1]).toBe(1);
  });

  it('rejects a file that is not an .opm', () => {
    const notOpm = new Uint8Array(64);
    notOpm.set(new TextEncoder().encode('GLTF'), 0);
    expect(() => decodeOpm(notOpm.buffer)).toThrow(/not an \.opm/);
  });

  it('takes the zero-copy path when the sections are contiguous', () => {
    const map = decodeOpm(buildOpm({ count: 64 }));
    expect(map.planarContiguous).toBe(true);

    const packed = packedVertexBytes(map);
    expect(packed.copied).toBe(false);
    expect(packed.bytes.byteLength).toBe(18 * 64);
    expect(packed.bytes.buffer).toBe(map.buffer);
  });

  it('repacks, and says so, when the sections are not contiguous', () => {
    const map = decodeOpm(buildOpm({ count: 64, gap: 16 }));
    expect(map.planarContiguous).toBe(false);

    const packed = packedVertexBytes(map);
    expect(packed.copied).toBe(true);
    expect(packed.bytes.byteLength).toBe(18 * 64);
    expect(packed.bytes.buffer).not.toBe(map.buffer);

    // The repack must preserve the planar order the engine expects: position, colour, segment.
    const positions = new Float32Array(packed.bytes.buffer, 0, 64 * 3);
    expect(positions[3]).toBeCloseTo(1);
    expect(packed.bytes[12 * 64 + 3]).toBe(200);
    const segments = new Uint16Array(packed.bytes.buffer, 16 * 64, 64);
    expect(segments[1]).toBe(1);
  });

  it('derives a footprint radius that encloses every corner of the bounds', () => {
    const map = decodeOpm(buildOpm({ count: 4 }));
    // bounds are x -3..4 and z -8..-1, so the furthest ground-plane corner is (4, -8).
    expect(footprintRadiusOf(map.header)).toBeCloseTo(Math.hypot(4, 8));
  });

  it('derives an observed panel envelope from source camera facts, not Atlas placement', () => {
    const envelope = sourcePanelEnvelopeOf(decodeOpm(buildOpm({ count: 4 })).header);
    expect(envelope.nearDepth).toBeCloseTo(1);
    expect(envelope.farDepth).toBeCloseTo(8);
    expect(envelope.farHalfWidth).toBeCloseTo(
      8 * Math.tan((55 * Math.PI) / 360) * (4 / 3),
    );
  });

  it('refuses a structurally valid header whose source aspect contradicts the camera', () => {
    const buffer = buildOpm({ count: 4 });
    const view = new DataView(buffer);
    const length = view.getUint32(4, true);
    const bytes = new Uint8Array(buffer, 8, length);
    const header = JSON.parse(new TextDecoder().decode(bytes)) as OpmHeader;
    const changed = new TextEncoder().encode(JSON.stringify({
      ...header,
      viewpoint: { ...header.viewpoint, aspect: 2 },
    }));
    expect(changed.length).toBeLessThanOrEqual(length);
    bytes.fill(0x20);
    new Uint8Array(buffer).set(changed, 8);
    view.setUint32(4, changed.length, true);
    expect(() => decodeOpm(buffer)).toThrow(/aspect/);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { decodeOpm, footprintRadiusOf } from '../src/playcanvas/opm.js';

/**
 * The Python writer and this decoder, pinned against a committed file.
 *
 * `.opm` now has two producers in two languages: `@orimera/scene-synth` writes synthetic fixtures
 * and `orimera.reconstruction` writes what a photograph turned out to have been looking at. Both
 * are read by this decoder, and the whole point of the format is that the renderer cannot tell
 * them apart, so a measurement taken against a fixture is a measurement of the real path.
 *
 * Neither language can import the other, so the pin is a small file written by one and read by
 * the other. `tests/test_reconstruction.py` regenerates it and asserts it is byte-identical, so a
 * change to the writer fails on the Python side and a change to the container fails here.
 *
 * The fixture has 77 points on purpose. Seventy-seven is not a multiple of four, which is exactly
 * the case where the TypeScript writer's per-section sixteen-byte alignment leaves a gap and the
 * file falls off the renderer's zero-copy path. The Python writer aligns only the start of the
 * first section, so this file is contiguous and this test would notice if that stopped being true.
 */

const FIXTURE = new URL('./fixtures/python-writer.opm', import.meta.url);

function load(): ArrayBuffer {
  const bytes = readFileSync(FIXTURE);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('a point map written by the Python reconstruction path', () => {
  it('decodes with this binding, with no special case for who wrote it', () => {
    const map = decodeOpm(load());
    expect(map.header.format).toBe('orimera-point-map');
    expect(map.header.version).toBe(1);
    expect(map.header.pointCount).toBe(77);
    // A point map is rung 3 by construction. A 1 here would describe a splat.
    expect(map.header.rung).toBe(3);
    expect(map.header.colorAlpha).toBe('confidence');
  });

  it('takes the zero-copy path, which is the whole reason the writer packs the way it does', () => {
    // False here means the binding does a per-point CPU repack on every photograph in the corpus.
    // It reports that rather than hiding it, which is why this is worth asserting rather than
    // assuming: the failure is a performance one and it is silent.
    expect(decodeOpm(load()).planarContiguous).toBe(true);
  });

  it('exposes the three sections as views the engine can upload without touching a point', () => {
    const map = decodeOpm(load());
    expect(map.position).toHaveLength(77 * 3);
    expect(map.color).toHaveLength(77 * 4);
    expect(map.segment).toHaveLength(77);
    expect(map.packedByteLength).toBe(18 * 77);
  });

  it("reads a world in this binding's own frame: up is +Y and the camera looks down -Z", () => {
    // The Python side converts out of MoGe's y-down, z-forward camera convention. Getting that
    // wrong produces a world that renders perfectly, upside down and behind the camera, and this
    // is the assertion on the far side of the language boundary that would catch it.
    const map = decodeOpm(load());
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < map.position.length; i += 3) {
      minZ = Math.min(minZ, map.position[i]!);
      maxZ = Math.max(maxZ, map.position[i]!);
    }
    expect(maxZ).toBeLessThan(0);
    expect(minZ).toBeLessThanOrEqual(maxZ);
  });

  it('has a footprint the layout solver can be given', () => {
    expect(footprintRadiusOf(decodeOpm(load()).header)).toBeGreaterThan(0);
  });
});

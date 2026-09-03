import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PACKED_STRIDE_BYTES, decodeOpm, footprintRadiusOf } from '../src/playcanvas/opm.js';

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
 * the case where a per-section sixteen-byte alignment leaves a gap and the file falls off the
 * renderer's zero-copy path. Both writers now align only the start of the first section, so this
 * file is contiguous and this test would notice if that stopped being true.
 *
 * It is an OPM/2 file. ADR-0010 D9 regenerates this pin rather than converting it, because its
 * input is the flat-plane test double rather than a model: it reproduces exactly, which is what
 * makes a byte-identical assertion on the Python side possible at all.
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
    expect(map.header.version).toBe(2);
    expect(map.header.pointCount).toBe(77);
    // A point map is rung 3 by construction. A 1 here would describe a splat.
    expect(map.header.rung).toBe(3);
    // Support, not confidence. What the depth stage puts in the alpha channel is a spacing
    // ratio, and OPM/2 is where it stopped claiming to be a probability.
    expect(map.header.colorAlpha).toBe('support');
    // Both grids are stated. Here they are equal because the double does not downscale an
    // eleven-pixel image; the point is that the file says so rather than leaving it inferable.
    expect(map.header.sourceImage).toEqual({ width: 11, height: 7 });
    expect(map.header.modelImage).toEqual({ width: 11, height: 7 });
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
    expect(map.tags).toHaveLength(77 * 2);
    expect(map.packedByteLength).toBe(PACKED_STRIDE_BYTES * 77);
  });

  it('carries a flags channel the Python writer filled and left every reserved bit of at zero', () => {
    // The flat plane has no depth discontinuity, so nothing lost a neighbour and bit 0 is clear
    // throughout. What this pins is that the channel exists, is the right width and is not
    // carrying whatever happened to be in the buffer: a writer that forgot it would leave the
    // second channel holding a segment id.
    const map = decodeOpm(load());
    const flags = new Set<number>();
    for (let i = 0; i < 77; i += 1) flags.add(map.tags[i * 2 + 1]!);
    expect([...flags]).toEqual([0]);
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

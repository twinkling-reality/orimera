import { describe, expect, it } from 'vitest';
import {
  MEDIA_SAMPLE_EDGE,
  readSourceLight,
  resolveWorldStyleParameters,
  sourceLightParameters,
  worldArtProfile,
  perceptualColour,
  contrastRatio,
  type MediaSample,
} from '../src/world-profiles.js';

/** A flat sample of one colour, which is the simplest library a person could have. */
function flat(red: number, green: number, blue: number): MediaSample {
  const pixels = new Uint8ClampedArray(MEDIA_SAMPLE_EDGE * MEDIA_SAMPLE_EDGE * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
  return { pixels, width: MEDIA_SAMPLE_EDGE, height: MEDIA_SAMPLE_EDGE };
}

/** Half one colour, half another, so hue selection has something to weigh. */
function split(a: readonly number[], b: readonly number[]): MediaSample {
  const sample = flat(0, 0, 0);
  const half = sample.pixels.length / 2;
  for (let offset = 0; offset < sample.pixels.length; offset += 4) {
    const source = offset < half ? a : b;
    sample.pixels[offset] = source[0]!;
    sample.pixels[offset + 1] = source[1]!;
    sample.pixels[offset + 2] = source[2]!;
    sample.pixels[offset + 3] = 255;
  }
  return sample;
}

describe('reading a world from its photographs', () => {
  it('changes nothing at rest, because a control at its default is not an edit', () => {
    // `source-light-v1` constructs the interface roots from four registers. If its defaults did
    // not land exactly on what Aeroheart authored, merely registering the module would have
    // restyled the world, and every later comparison would be against a moved baseline.
    // Two paths reach the resting interface: an unparameterised read returns the recipe literals
    // without running a module, and a read at the control defaults constructs them. They must
    // agree byte for byte, or an unrelated slider silently restyles the world the first time it
    // is touched and every later comparison is against a moved baseline.
    const literal = worldArtProfile('origin-landscape', 1).interfacePalette;
    const constructed = worldArtProfile('origin-landscape', 1,
      resolveWorldStyleParameters('origin-landscape')).interfacePalette;
    expect(constructed).toEqual(literal);
    expect(literal).toEqual({
      ink: '#17333b', plate: '#fffaf0', structure: '#318fa5',
      evidence: '#fa6a5b', uncertain: '#7b71b5',
    });
  });

  it('is deterministic, because a world that shifted colour between loads is a bug', () => {
    const library = [flat(220, 90, 60), flat(60, 120, 200), split([12, 40, 30], [240, 230, 200])];
    expect(readSourceLight(library)).toEqual(readSourceLight(library));
    expect(readSourceLight(library)).toEqual(readSourceLight([...library]));
  });

  it('reads different hues from different libraries', () => {
    const warm = readSourceLight([flat(226, 88, 54)]);
    const cool = readSourceLight([flat(54, 118, 226)]);
    expect(warm.hue).toBeDefined();
    expect(cool.hue).toBeDefined();
    expect(Math.abs(warm.hue! - cool.hue!)).toBeGreaterThan(0.1);
  });

  it('says nothing rather than guessing when there is nothing to read', () => {
    expect(readSourceLight([]).sampled).toBe(0);
    // Fully transparent pixels are not evidence of a colour.
    const blank = flat(200, 40, 40);
    for (let offset = 3; offset < blank.pixels.length; offset += 4) blank.pixels[offset] = 0;
    expect(readSourceLight([blank]).sampled).toBe(0);
  });

  it('keeps the style value the world already had for anything it cannot answer', () => {
    // Pure grey carries lightness but no hue, so hue and warmth must fall through.
    const grey = readSourceLight([flat(128, 128, 128)]);
    expect(grey.sampled).toBeGreaterThan(0);
    expect(grey.hue).toBeUndefined();
    const values = sourceLightParameters(grey, { 'source-hue': 0.19, 'source-warmth': 0.81 });
    expect(values['source-hue']).toBe(0.19);
    expect(values['source-warmth']).toBe(0.81);
    expect(values['source-depth']).toBeTypeOf('number');
  });

  it('always produces a complete, in-range set the existing apply path can take', () => {
    for (const library of [
      [flat(8, 10, 14)], [flat(250, 250, 248)], [flat(226, 88, 54), flat(54, 118, 226)], [],
    ]) {
      const values = sourceLightParameters(readSourceLight(library), {});
      expect(Object.keys(values).sort())
        .toEqual(['source-depth', 'source-hue', 'source-light', 'source-warmth']);
      for (const value of Object.values(values)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('cannot produce an unreadable interface from any library, including the worst ones', () => {
    // A photograph decides the hue. It never decides whether the interface can be read.
    const libraries: MediaSample[][] = [
      [flat(0, 0, 0)], [flat(255, 255, 255)], [flat(255, 0, 0)], [flat(0, 255, 0)],
      [flat(0, 0, 255)], [flat(255, 255, 0)], [flat(120, 0, 255)], [flat(2, 3, 2)],
      [split([255, 0, 0], [0, 0, 255])], [split([0, 0, 0], [255, 255, 255])],
    ];
    for (const library of libraries) {
      const values = sourceLightParameters(readSourceLight(library), {});
      const profile = worldArtProfile('origin-landscape', 1, values);
      const c = profile.ui.colors;
      expect(contrastRatio(c.ink, c.raised)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(c.body, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.companionText, c.companionSurface)).toBeGreaterThanOrEqual(7);
      for (const role of ['muted', 'accent', 'secondary', 'user', 'capture', 'inference'] as const) {
        expect(contrastRatio(c[role], c.surface)).toBeGreaterThanOrEqual(4.5);
      }
      // The plate stays a plate. A dark library may not invert the world.
      expect(perceptualColour(c.raised).lightness).toBeGreaterThan(0.9);
    }
  });

  it('moves the interface when the library changes, or it is not doing anything', () => {
    const warm = worldArtProfile('origin-landscape', 1,
      sourceLightParameters(readSourceLight([flat(226, 88, 54)]), {}));
    const cool = worldArtProfile('origin-landscape', 1,
      sourceLightParameters(readSourceLight([flat(54, 118, 226)]), {}));
    expect(warm.ui.colors.accent).not.toBe(cool.ui.colors.accent);
    expect(warm.ui.colors.ink).not.toBe(cool.ui.colors.ink);
    // And the world's own field is untouched: this reads the interface, not the scene.
    expect(warm.palette).toEqual(cool.palette);
  });
});

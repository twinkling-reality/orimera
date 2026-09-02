/**
 * An interface palette read out of the person's own photographs.
 *
 * The world's colour was ten authored hex constants. That is defensible for a demonstration and
 * wrong for the product: Orimera's claim is that this is *your* world, and a world whose colour
 * was decided by whoever wrote the recipe is not yours in any sense a person would recognise.
 * This reads the roots out of the media that is already loaded and already on screen.
 *
 * Three rules make that safe rather than merely clever:
 *
 * 1. **It is pure and deterministic.** Same pixels in, same palette out, every time, on every
 *    machine. No sampling by chance, no clock, no device dependence. A world that shifted colour
 *    between two loads of the same library would be a bug the person could see and not explain.
 * 2. **It is bounded before it is returned.** Every root is clamped into a lightness and chroma
 *    range that the derivation can build a readable interface from, so a library of night shots
 *    or a library of white walls both produce something legible. A photograph decides the hue.
 *    It never decides whether the interface can be read.
 * 3. **It is a proposal, not an effect, and it is not even a colour.** This module returns four
 *    numbers on registered controls. The customization contract lets a proposal carry capability
 *    values and nothing else, so a reading cannot be hex codes injected past validation. Turning
 *    those numbers into colours is `source-light-v1`, which is reviewed code. That constraint
 *    made the better product too: what the photographs suggest arrives as slider positions the
 *    person can then move.
 *
 * It samples colour only. No pixel, no identifier and no derived embedding leaves this function,
 * and the returned palette is five colours that could equally have been typed by hand.
 */

/** One image reduced to a small fixed grid. The caller owns decoding; this owns the maths. */
export interface MediaSample {
  /** RGBA bytes, row-major, four per pixel, exactly `width * height * 4` long. */
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * The grid every image is reduced to before sampling.
 *
 * Small on purpose. A palette is a summary, and summarising from a thumbnail rather than from
 * full resolution keeps this cheap enough to run on the main thread while a world is loading,
 * makes the result stable against re-encoding, and means a face or a licence plate is gone before
 * the maths starts.
 */
export const MEDIA_SAMPLE_EDGE = 24;

const TWO_PI = Math.PI * 2;
const HUE_BINS = 24;

/** The warm arc, in radians. Where a library sits inside it becomes the evidence mark's warmth. */
const WARM_ARC = Object.freeze({ from: -0.9, to: 1.75 });

interface Bin {
  readonly index: number;
  weight: number;
  chroma: number;
  lightness: number;
  x: number;
  y: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const normaliseHue = (hue: number): number => ((hue % TWO_PI) + TWO_PI) % TWO_PI;

const inArc = (hue: number, arc: { readonly from: number; readonly to: number }): boolean => {
  const h = normaliseHue(hue);
  const from = normaliseHue(arc.from);
  const to = normaliseHue(arc.to);
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
};

const toLinear = (value: number): number =>
  (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

const oklabOf = (red: number, green: number, blue: number): {
  l: number; c: number; h: number;
} => {
  const r = toLinear(red / 255);
  const g = toLinear(green / 255);
  const b = toLinear(blue / 255);
  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * long + 0.7936177850 * medium - 0.0040720468 * short;
  const a = 1.9779984951 * long - 2.4285922050 * medium + 0.4505937099 * short;
  const bb = 0.0259040371 * long + 0.7827717662 * medium - 0.8086757660 * short;
  return { l: lightness, c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
};

/**
 * Weighted circular mean of the bins in an arc, or null when the arc holds nothing worth using.
 *
 * A mean of hues has to be taken on the circle. Averaging the numbers puts the mean of red and
 * violet in the middle of green, which is the one colour neither photograph contained.
 */
function representative(bins: readonly Bin[], arc?: {
  readonly from: number; readonly to: number;
}): { readonly hue: number; readonly chroma: number; readonly weight: number } | null {
  let x = 0;
  let y = 0;
  let chroma = 0;
  let weight = 0;
  for (const bin of bins) {
    if (bin.weight <= 0) continue;
    const hue = Math.atan2(bin.y, bin.x);
    if (arc !== undefined && !inArc(hue, arc)) continue;
    x += bin.x;
    y += bin.y;
    chroma += bin.chroma;
    weight += bin.weight;
  }
  if (weight <= 0 || (x === 0 && y === 0)) return null;
  return { hue: Math.atan2(y, x), chroma: chroma / weight, weight };
}

/**
 * What a library of photographs says about the four interface registers.
 *
 * Every value is 0..1 and is a position on a registered control, never a colour. The reading is
 * the whole of what this module produces; `source-light-v1` is the only thing that turns these
 * into colours, and it is reviewed code rather than data. Roots the media cannot honestly answer
 * are simply absent, and the caller keeps whatever the world already had, because a library with
 * no warm colour in it should not be given an invented one.
 */
export interface SourceLightReading {
  readonly hue?: number;
  readonly warmth?: number;
  readonly depth?: number;
  readonly light?: number;
  /** How many usable pixels stood behind the reading. Zero means it says nothing. */
  readonly sampled: number;
}

export function readSourceLight(samples: readonly MediaSample[]): SourceLightReading {
  const bins: Bin[] = Array.from({ length: HUE_BINS }, (_, index) => ({
    index, weight: 0, chroma: 0, lightness: 0, x: 0, y: 0,
  }));
  const lightnesses: number[] = [];
  let counted = 0;

  for (const sample of samples) {
    const expected = sample.width * sample.height * 4;
    if (sample.width <= 0 || sample.height <= 0 || sample.pixels.length < expected) continue;
    for (let offset = 0; offset < expected; offset += 4) {
      if ((sample.pixels[offset + 3] ?? 0) < 128) continue;
      const { l, c, h } = oklabOf(
        sample.pixels[offset] ?? 0,
        sample.pixels[offset + 1] ?? 0,
        sample.pixels[offset + 2] ?? 0,
      );
      lightnesses.push(l);
      counted += 1;
      // Near-black, near-white and near-grey pixels carry no usable hue, and a photograph is
      // mostly those. Letting them vote drags every world toward the same beige.
      if (c < 0.03 || l < 0.12 || l > 0.94) continue;
      const bin = bins[Math.min(HUE_BINS - 1, Math.floor(normaliseHue(h) / TWO_PI * HUE_BINS))];
      if (bin === undefined) continue;
      // Weighting by chroma squared means a small vivid area outvotes a large muted one, which is
      // what a person means when they say a photograph "is" a colour.
      const weight = c * c;
      bin.weight += weight;
      bin.chroma += c * weight;
      bin.lightness += l * weight;
      bin.x += Math.cos(h) * weight;
      bin.y += Math.sin(h) * weight;
    }
  }

  if (counted === 0) return Object.freeze({ sampled: 0 });
  lightnesses.sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    lightnesses[clamp(Math.round(fraction * (lightnesses.length - 1)), 0, lightnesses.length - 1)]!;

  const dominant = representative(bins);
  const warm = representative(bins, WARM_ARC);

  const reading: {
    hue?: number; warmth?: number; depth?: number; light?: number; sampled: number;
  } = { sampled: counted };

  if (dominant !== null) reading.hue = normaliseHue(dominant.hue) / TWO_PI;
  if (warm !== null) {
    // Where in the warm arc the library actually sits, so a library of sunsets and a library of
    // red doors do not receive the same mark.
    const offset = normaliseHue(warm.hue - WARM_ARC.from) / (WARM_ARC.to - WARM_ARC.from);
    reading.warmth = clamp(offset, 0, 1);
  }
  // A library shot at dusk earns a deeper reading register than one shot on snow. The register is
  // bounded, so neither can make the interface unreadable.
  reading.depth = clamp(1 - percentile(0.08) * 2.4, 0, 1);
  reading.light = clamp(percentile(0.94) * 1.05 - 0.05, 0, 1);
  return Object.freeze(reading);
}

/**
 * The reading as parameter values for the registered `interface.*` controls.
 *
 * Absent readings keep the value the style already has, so this is always a complete, valid set
 * that the existing preview and apply path can take without a special case.
 */
export function sourceLightParameters(
  reading: SourceLightReading,
  current: Readonly<Record<string, number | string | boolean>>,
): Readonly<Record<string, number>> {
  const keep = (key: string, fallback: number): number => {
    const value = current[key];
    return typeof value === 'number' ? value : fallback;
  };
  return Object.freeze({
    'source-hue': reading.hue ?? keep('source-hue', 0.52),
    'source-warmth': reading.warmth ?? keep('source-warmth', 0.5),
    'source-depth': reading.depth ?? keep('source-depth', 0.5),
    'source-light': reading.light ?? keep('source-light', 0.5),
  });
}

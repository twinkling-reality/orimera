/**
 * Turning the photographs already on screen into pixels the palette reader can use.
 *
 * The maths lives in `@exulanica/presentation`, where it is pure and testable. Decoding is a browser
 * job and it lives here, so nothing in the style layer has to know what an `Image` is.
 *
 * Two things this deliberately does not do. It never re-fetches: it reads the same
 * bounded-lifetime blob URLs the renderer already holds, so no additional authorized request is
 * made for a colour, and revoking those URLs at session end still frees everything. And it never
 * retains a pixel: each image is drawn to one reused offscreen canvas, reduced to a
 * `MEDIA_SAMPLE_EDGE` grid, copied out as a small array, and the canvas is overwritten by the next
 * image. What leaves this module is roughly two thousand bytes per photograph, at a size where a
 * face is a smudge.
 */

import { MEDIA_SAMPLE_EDGE, type MediaSample } from '@exulanica/presentation';

/** A source the renderer already resolved to authorized bytes. */
export interface SampleableSource {
  readonly url: string;
  readonly available: boolean;
}

const decode = async (url: string): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => resolve(null), { once: true });
    image.src = url;
  });

/**
 * Reduce every available source to a small grid, in the order the catalog gave them.
 *
 * Order matters because the palette must be deterministic: the same library has to produce the
 * same world every time it loads, and `Promise.all` over a set that resolves in network order
 * would quietly make it depend on the weather. These run in sequence and accumulate in sequence.
 */
export async function sampleSources(
  sources: readonly SampleableSource[],
  documentRef: Document = document,
): Promise<readonly MediaSample[]> {
  const canvas = documentRef.createElement('canvas');
  canvas.width = MEDIA_SAMPLE_EDGE;
  canvas.height = MEDIA_SAMPLE_EDGE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return Object.freeze([]);
  const samples: MediaSample[] = [];
  for (const source of sources) {
    if (!source.available) continue;
    const image = await decode(source.url);
    if (image === null || image.naturalWidth === 0) continue;
    context.clearRect(0, 0, MEDIA_SAMPLE_EDGE, MEDIA_SAMPLE_EDGE);
    context.drawImage(image, 0, 0, MEDIA_SAMPLE_EDGE, MEDIA_SAMPLE_EDGE);
    const data = context.getImageData(0, 0, MEDIA_SAMPLE_EDGE, MEDIA_SAMPLE_EDGE);
    samples.push(Object.freeze({
      pixels: new Uint8ClampedArray(data.data),
      width: MEDIA_SAMPLE_EDGE,
      height: MEDIA_SAMPLE_EDGE,
    }));
  }
  return Object.freeze(samples);
}

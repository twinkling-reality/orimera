import { hash3, unit } from './rng.js';

/**
 * Value noise and fbm, in three dimensions, evaluated at world positions.
 *
 * Deliberately 3D and world-space rather than 2D and image-space: colour detail and dropout
 * blotches then stay attached to the surface instead of swimming when the resolution changes.
 * This is what makes the 250k and 4M rungs of the ladder look like the same photograph.
 */

const fade = (t: number): number => t * t * (3 - 2 * t);

export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const zf = fade(z - zi);

  let acc = 0;
  for (let dz = 0; dz <= 1; dz += 1) {
    const wz = dz === 1 ? zf : 1 - zf;
    for (let dy = 0; dy <= 1; dy += 1) {
      const wy = dy === 1 ? yf : 1 - yf;
      for (let dx = 0; dx <= 1; dx += 1) {
        const wx = dx === 1 ? xf : 1 - xf;
        acc += wx * wy * wz * unit(hash3(xi + dx, yi + dy, zi + dz, seed));
      }
    }
  }
  return acc;
}

/** Fractal Brownian motion. Returns roughly [0, 1]. */
export function fbm3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves = 4,
  lacunarity = 2.03,
  gain = 0.5,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 7919);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
}

/** Signed, roughly [-1, 1]. */
export const fbm3Signed = (
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves = 4,
): number => fbm3(x, y, z, seed, octaves) * 2 - 1;

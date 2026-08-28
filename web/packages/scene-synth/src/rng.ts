/**
 * Deterministic hashing and pseudo-randomness.
 *
 * Every stochastic decision in the generator is a HASH of integer coordinates plus a seed, never
 * a stateful PRNG stepped in scan order. Two consequences that matter for a bake-off:
 *
 *   - Output is byte-identical across machines, Node versions and thread counts.
 *   - Changing the resolution does not reshuffle the noise. A 250k scene and a 4M scene of the
 *     same seed are the same place photographed at two resolutions, which is what makes the
 *     ladder a ladder rather than five unrelated scenes.
 */

/** 32-bit integer hash (Thomas Wang / Murmur finalizer style). Avalanches well, no state. */
export function hashU32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

export function hash2(x: number, y: number, seed: number): number {
  return hashU32((Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed) | 0);
}

export function hash3(x: number, y: number, z: number, seed: number): number {
  return hashU32(
    (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ seed) | 0,
  );
}

/** Uniform in [0, 1). */
export const unit = (h: number): number => h / 4294967296;

export const hash2Unit = (x: number, y: number, seed: number): number => unit(hash2(x, y, seed));

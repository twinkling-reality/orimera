/**
 * A seeded PRNG, so every composition is byte-identical between reloads.
 *
 * That matters more here than it looks. The landing atmosphere is the first thing a user sees and
 * the first thing a reviewer screenshots; a field that reshuffles on every reload cannot be
 * reviewed, cannot be regression-tested, and makes "is this the same composition" unanswerable.
 * mulberry32 is chosen because it is four lines, has no dependency, and does not vary across
 * library versions.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, for cluster falloff that looks like haze rather than like a disc of confetti. */
export function gaussian(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

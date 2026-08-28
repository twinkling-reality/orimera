import { hash2 } from './rng.js';

/**
 * Trim a keep mask to EXACTLY a target count, deterministically and without spatial bias.
 *
 * The resolution search gets close to the target and then overshoots slightly; this closes the
 * gap. Two properties are required and neither is optional:
 *
 *   - EXACT. The bake-off ladder is 250k / 1M / 2M / 3M / 4M. "About a million" makes two
 *     renderers' numbers incomparable if each is measured on a different about-a-million.
 *   - SPATIALLY UNIFORM. Truncating in scan order would delete the bottom of the image, which is
 *     the ground plane, which is the densest and nearest part of the point map. That would change
 *     the depth distribution the bake-off exists to measure.
 *
 * Method: rank every kept pixel by a hash of its coordinates and keep the lowest N. Implemented
 * as a 16-bit histogram plus one small sort of the boundary bucket, so it is O(kept) rather than
 * a sort of several million keys.
 */
export function trimToExactly(
  keep: Uint8Array,
  width: number,
  height: number,
  keptCount: number,
  target: number,
  seed: number,
): number {
  if (target >= keptCount) return keptCount;

  const BUCKETS = 1 << 16;
  const hist = new Uint32Array(BUCKETS);
  const n = width * height;

  for (let i = 0; i < n; i += 1) {
    if (keep[i] === 0) continue;
    const h = hash2(i % width, (i / width) | 0, seed ^ 0x5bd1);
    hist[h >>> 16]! += 1;
  }

  let cumulative = 0;
  let boundary = 0;
  for (; boundary < BUCKETS; boundary += 1) {
    const next = cumulative + hist[boundary]!;
    if (next >= target) break;
    cumulative = next;
  }

  const fromBoundary = target - cumulative;
  const candidates: Array<{ i: number; h: number }> = [];

  for (let i = 0; i < n; i += 1) {
    if (keep[i] === 0) continue;
    const h = hash2(i % width, (i / width) | 0, seed ^ 0x5bd1);
    const b = h >>> 16;
    if (b < boundary) continue;
    if (b > boundary) {
      keep[i] = 0;
      continue;
    }
    candidates.push({ i, h });
  }

  // Deterministic total order: full hash, then pixel index.
  candidates.sort((a, b) => a.h - b.h || a.i - b.i);
  for (let c = fromBoundary; c < candidates.length; c += 1) keep[candidates[c]!.i] = 0;

  return target;
}

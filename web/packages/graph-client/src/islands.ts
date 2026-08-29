/**
 * What an island is, who decides it, and what an island may honestly carry.
 *
 * **An island is decided here, not on the server.** ADR-0005 records that whether an island is
 * one capture or a place-on-a-trip cluster is OPEN "until the real distribution of the corpus has
 * been measured", so the server returns capture ids and a grouping, and this maps them through an
 * injectable function.
 *
 * THE CORPUS HAS NOW BEEN MEASURED, so the default has changed. 80 photographs across five visits
 * to three places cluster into five scene groups of sixteen. One island per capture would be 80
 * islands, and `solveLayout` refuses more than five and says why: "a force layout whose behaviour
 * was never examined above five islands should fail loudly rather than produce a plausible-looking
 * arrangement nobody has checked". One island per scene group is five. The default is therefore
 * the group, falling back to the capture for anything the grouping did not place, which is the
 * honest answer for a photograph with no usable clock.
 *
 * The function is still injectable and the server still ships no island id, so this remains one
 * argument to have rather than a server change, which is exactly what it was kept for.
 */

import type { IslandIdRef, IslandRecord, ReconstructionRungRef } from './read-model.js';
import { type GraphPayload, toMs } from './wire.js';

/** How a capture becomes an island. See the module comment on why this is a parameter. */
export type IslandOf = (captureId: string) => IslandIdRef;

/**
 * The default: a capture belongs to the scene group that contains it, or stands alone.
 *
 * Built from the payload rather than being a constant, because the grouping is data the server
 * computed and the mapping cannot be known without it. A capture in no group becomes its own
 * island rather than being dropped or bundled into a nearby one: a photograph the clusterer could
 * not place is a real photograph, and hiding it would be losing evidence to a layout decision.
 */
export function groupIslands(payload: GraphPayload): IslandOf {
  const byCapture = new Map<string, IslandIdRef>();
  for (const group of payload.scene_groups) {
    for (const captureId of group.capture_ids) {
      byCapture.set(captureId, group.group_id as IslandIdRef);
    }
  }
  return (captureId) => byCapture.get(captureId) ?? (captureId as IslandIdRef);
}

/**
 * The islands, built from the grouping and from whatever the grouping did not place.
 *
 * Derived from the SAME `islandOf` the occurrences went through, rather than read straight off
 * `scene_groups`. A caller that injected its own function gets islands that match its own
 * occurrences; a set derived independently from the payload would silently disagree with the
 * anchors placed inside it, and the symptom would be an anchor rendered in a region it does not
 * belong to.
 *
 * `spreadMetres` is carried through only for a group whose members had a fix. A radius reported
 * for a group clustered on time alone would be a distance nothing measured.
 */
export function buildIslands(
  payload: GraphPayload,
  islandOf: IslandOf,
): readonly IslandRecord[] {
  const byIsland = new Map<IslandIdRef, IslandRecord>();

  for (const group of payload.scene_groups) {
    const islandId = islandOf(group.capture_ids[0] ?? group.group_id);
    // A rung this client cannot name takes its capture count with it. The count says how much of
    // the region is behind the rung, so `rung: null` beside a count of two reads as "no rung,
    // from two captures": a measurement standing behind a claim that was never made. Null says
    // nothing here has been through reconstruction, and then nothing here has a recorded rung to
    // count. It is the same answer the ungrouped branch below already gives.
    const rung = asRung(group.rung);
    byIsland.set(islandId, {
      islandId,
      captureIds: group.capture_ids,
      firstCapturedAtMs: toMs(group.first_utc),
      lastCapturedAtMs: toMs(group.last_utc),
      positionedCaptureCount: group.positioned_member_count,
      spreadMetres: group.positioned_member_count > 0 ? group.radius_m : null,
      rung,
      rungCaptureCount: rung === null ? 0 : group.rung_capture_count,
    });
  }

  // Anything the grouping did not place. One capture, one island, and the times are the times
  // its own occurrences carry rather than a group's.
  const grouped = new Set(payload.scene_groups.flatMap((group) => group.capture_ids));
  for (const row of payload.occurrences) {
    if (grouped.has(row.capture_id)) continue;
    const islandId = islandOf(row.capture_id);
    const existing = byIsland.get(islandId);
    const atMs = toMs(row.captured_at);
    byIsland.set(islandId, {
      islandId,
      captureIds: [row.capture_id],
      firstCapturedAtMs: minOf(existing?.firstCapturedAtMs ?? null, atMs),
      lastCapturedAtMs: maxOf(existing?.lastCapturedAtMs ?? null, atMs),
      positionedCaptureCount: 0,
      spreadMetres: null,
      // A capture the grouping did not place has no group to carry a rung, and the server
      // reports rungs per group. Null is the honest answer rather than a guess at rung 4.
      rung: null,
      rungCaptureCount: 0,
    });
  }

  // Ordered by when the photographs were taken, which is the layout solver's ordering key. An
  // island with no usable clock sorts last rather than to the epoch, because sorting it first
  // would make an undated photograph the anchor of the user's spatial memory.
  return [...byIsland.values()].sort((a, b) => {
    const left = a.firstCapturedAtMs ?? Number.POSITIVE_INFINITY;
    const right = b.firstCapturedAtMs ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0;
  });
}

/**
 * The rung, narrowed to the four the ladder has, or null.
 *
 * Null means nothing reconstructed this region, which is a different fact from rung 4 and is not
 * flattened into it: rung 4 means reconstruction ran and found nothing to place. A value outside
 * one to four is a server this client does not understand, and reporting it as a rung would be
 * showing a label for a ladder position that does not exist.
 */
function asRung(value: number | null): ReconstructionRungRef | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

function minOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

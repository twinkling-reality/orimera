import { describe, expect, it } from 'vitest';

import { adaptSnapshot } from '../src/index.js';
import type { GraphPayload } from '../src/index.js';
import { GROUP, PAYLOAD, WITH_UNGROUPED } from './graph-payload.js';

/**
 * ADR-0005's open question, now answered by measurement rather than left open.
 *
 * The corpus is 80 photographs across five visits, which cluster into five scene groups. One
 * island per capture is 80 islands and `solveLayout` refuses more than five. One island per
 * group is five. These tests pin the default that follows, and pin that it is still only a
 * default: the whole point of keeping the function injectable was that this stays an argument.
 */
describe('what an island is, decided by the client', () => {
  it('puts the captures of one scene group in one island', () => {
    const snapshot = adaptSnapshot(PAYLOAD);
    expect(snapshot.occurrences[0]!.islandId).toBe('g1');
    expect(snapshot.occurrences[1]!.islandId).toBe('g1');
    expect(snapshot.islands).toHaveLength(1);
    expect(snapshot.islands[0]!.captureIds).toEqual(['c1', 'c2']);
  });

  it('leaves a capture the grouping did not place standing on its own', () => {
    const snapshot = adaptSnapshot(WITH_UNGROUPED);
    expect(snapshot.occurrences[2]!.islandId).toBe('c3');
    expect(snapshot.islands.map((i) => i.islandId)).toEqual(['c3', 'g1']);
  });

  it('orders islands by when their photographs were taken, which is the layout ordering key', () => {
    const snapshot = adaptSnapshot(WITH_UNGROUPED);
    expect(snapshot.islands[0]!.firstCapturedAtMs).toBeLessThan(
      snapshot.islands[1]!.firstCapturedAtMs!,
    );
  });

  it('carries the spread only for a group whose members actually had a fix', () => {
    expect(adaptSnapshot(PAYLOAD).islands[0]!.spreadMetres).toBe(14);
    const unpositioned: GraphPayload = {
      ...PAYLOAD,
      scene_groups: [{ ...GROUP, positioned_member_count: 0, radius_m: null }],
    };
    // Null rather than zero. A group clustered on time alone has no measured radius, and zero
    // would read as "every photograph was taken from the same spot".
    expect(adaptSnapshot(unpositioned).islands[0]!.spreadMetres).toBeNull();
  });

  it('still lets the caller decide, which is what the injection point was kept for', () => {
    const snapshot = adaptSnapshot(PAYLOAD, (captureId) => `island:${captureId}` as never);
    expect(snapshot.occurrences.map((o) => o.islandId)).toEqual(['island:c1', 'island:c2']);
  });
});

/**
 * A rung and the count beside it are one statement, and they stand or fall together.
 *
 * `rung: null` and `rung: 4` are different facts, per the read model's own comment: null means
 * nothing here has been through reconstruction, and 4 means reconstruction ran and found too
 * little to place. The count beside the rung says how much of the region is behind it, so a
 * count reported next to no rung is a measurement behind a claim that was not made.
 */
describe('what a rung says, and what the count beside it says', () => {
  const withRung = (rung: number | null, count: number): GraphPayload => ({
    ...PAYLOAD,
    scene_groups: [{ ...GROUP, rung, rung_capture_count: count }],
  });

  it('takes the capture count to zero for a rung this client cannot name', () => {
    // Rung 7 is a server this client does not understand. It reports no rung, and therefore
    // reports nothing behind the rung either: "no rung, from two captures" is two facts where
    // the client has one.
    const island = adaptSnapshot(withRung(7, 2)).islands[0]!;
    expect(island.rung).toBeNull();
    expect(island.rungCaptureCount).toBe(0);
  });

  it('takes the capture count to zero for a group nothing reconstructed', () => {
    // The same rule for the ordinary null. It is also what the ungrouped-capture branch already
    // answers, so a grouped region and a loose photograph now say the same thing the same way.
    const island = adaptSnapshot(withRung(null, 5)).islands[0]!;
    expect(island.rung).toBeNull();
    expect(island.rungCaptureCount).toBe(0);
  });

  it('carries rung 4 and its count through, because running and finding nothing is a fact', () => {
    // The guard against the rule above eating the honest rung 4. Reconstruction ran over sixteen
    // captures and placed none of them, and that is a thing the interface has to be able to say.
    const island = adaptSnapshot(withRung(4, 16)).islands[0]!;
    expect(island.rung).toBe(4);
    expect(island.rungCaptureCount).toBe(16);
  });
});

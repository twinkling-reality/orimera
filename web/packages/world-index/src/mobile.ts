import type { EntityRecord, GraphSnapshot } from '@exulanica/graph-client';
import { occurrencesOf } from '@exulanica/graph-client';

/**
 * MOBILE (interaction-model.md 2.5), and why this package is the default there.
 *
 * VERIFIED: Pointer Lock support data lists iOS Safari 3.2 through 26.6 as Not supported, Android
 * Chrome 151 as Not supported, Samsung Internet 4 through 30 as Not supported.
 * https://caniuse.com/pointerlock
 *
 * "Consequence: mouse-look first-person navigation is impossible on iOS Safari and Android
 * Chrome. Since the MVP is browser-only with no native app, mobile is a genuinely different mode,
 * and ITS DEFAULT ENTRY POINT IS THE WORLD INDEX WITH TAP-TO-TRAVEL, not the Atlas. This is a
 * hard platform limit with no workaround, not a scoping choice, and IT IS NOT SOLVABLE BY
 * EFFORT."
 *
 * And: "This is not a consolation prize: for 'where else does this person appear', a searchable
 * list with evidence playback is the better interface ON ANY DEVICE."
 */

export interface DeviceCapabilities {
  /** Feature-detected, never inferred from a user agent string. */
  readonly pointerLockSupported: boolean;
  readonly touch: boolean;
}

export type EntrySurface = 'atlas' | 'world-index';

export function entrySurface(caps: DeviceCapabilities): EntrySurface {
  if (!caps.pointerLockSupported) return 'world-index';
  return caps.touch ? 'world-index' : 'atlas';
}

/** 2.5 and section 9: "Touch targets are at least 44 CSS px". */
export const MIN_TOUCH_TARGET_PX = 44;

/**
 * "No virtual joystick. A joystick plus drag-look on a phone is a well known failure, and
 * tap-to-travel reuses machinery Locate needs anyway."
 */
export const VIRTUAL_JOYSTICK_SUPPORTED = false;

/**
 * A request to travel to an entity, from a tap in the list or from Locate in the detail view.
 *
 * `target` is the literal `'vantage_pose'` and there is no position field, deliberately. 6.2:
 * "Locate targets A VANTAGE POSE, NEVER THE ANCHOR POSITION (standing inside a person is not a
 * view of a person)." Computing that pose needs atlas-space geometry, which this package may not
 * touch: `.dependency-cruiser.cjs` bars everything outside atlas-core and atlas-react from
 * `presentation-metrics`, because an atlas position is a layout artifact and reading it as
 * geometry is risk R-48. So world-index names the anchor and states the intent, and the Atlas
 * works out where to stand.
 */
export interface TravelRequest {
  readonly entityId: string;
  readonly anchorId: string;
  readonly islandId: string;
  readonly target: 'vantage_pose';
  readonly reason: 'locate' | 'tap_to_travel';
  /** 2.5: "Any touch interrupts travel." */
  readonly interruptibleByAnyTouch: true;
  /**
   * Under reduced motion, travel becomes a short cross-fade with an arrival caption, "ending at
   * the identical pose SO NO OTHER SUBSYSTEM BRANCHES ON WHICH PATH RAN" (6.2). The flag rides
   * along so the Atlas picks the transition; the destination is the same either way.
   */
  readonly reducedMotion: boolean;
}

/**
 * Build a travel request, or null when there is nowhere to go.
 *
 * Null is a real outcome: an entity with no occurrences (every link revoked, say) cannot be
 * located, and the list must render the row with the action disabled rather than send the camera
 * to a default position and call it an arrival.
 */
export function travelTo(
  snapshot: GraphSnapshot,
  entity: EntityRecord,
  reason: TravelRequest['reason'],
  reducedMotion: boolean,
): TravelRequest | null {
  const occurrence = occurrencesOf(snapshot, entity.entityId)[0];
  if (occurrence === undefined) return null;
  return Object.freeze({
    entityId: entity.entityId,
    anchorId: occurrence.anchorId,
    islandId: occurrence.islandId,
    target: 'vantage_pose',
    reason,
    interruptibleByAnyTouch: true,
    reducedMotion,
  });
}

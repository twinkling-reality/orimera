/**
 * Tap to go, hold to look.
 *
 * The Atlas Map is not a panel: it is the same world under a lifted camera, which is why it can
 * afford to take the whole view and why shrinking it would destroy the one thing it is for.
 * Relationship traces are shown only there, because at eye height a trace reads as an arbitrary
 * road and only an overview makes its endpoints legible as a relationship.
 *
 * That leaves a gap between "glance at where I am" and "go to the map", and a second rendering of
 * the world in a corner is the wrong way to close it: it costs a whole extra camera every frame
 * and it is the HUD overlay the world is deliberately built without. A held key closes it for
 * nothing. Tapping still travels to the Map as a destination; holding lifts you for as long as
 * you keep holding and drops you back exactly where you were standing.
 *
 * The timers are injected so the decision can be tested without waiting on a real clock.
 */

/**
 * How long a press has to last before it counts as a look rather than a trip.
 *
 * Short enough that holding never feels like waiting, long enough to sit clear of an ordinary
 * keypress, which lands well under a tenth of a second.
 */
export const MAP_PEEK_HOLD_MS = 180;

export interface MapPeekHandlers {
  /** Whether the Map camera is already the active one. */
  readonly isMapActive: () => boolean;
  readonly enterMap: () => void;
  readonly leaveMap: () => void;
  /** The tap meaning: Map as a destination you travel to and stay in. */
  readonly toggleMap: () => void;
  readonly schedule: (run: () => void, ms: number) => number;
  readonly cancel: (handle: number) => void;
}

export class MapPeek {
  private pressed = false;
  private peeking = false;
  private handle: number | null = null;

  constructor(private readonly handlers: MapPeekHandlers) {}

  /** Key down. Repeats while held are ignored, so the timer is armed exactly once. */
  press(): void {
    if (this.pressed) return;
    this.pressed = true;
    // Holding while already in the Map has nothing to lift to, so it stays a plain tap.
    if (this.handlers.isMapActive()) return;
    this.handle = this.handlers.schedule(() => {
      this.handle = null;
      if (!this.pressed) return;
      this.peeking = true;
      this.handlers.enterMap();
    }, MAP_PEEK_HOLD_MS);
  }

  /** Key up. Either the look ends, or the press was short enough to have meant the destination. */
  release(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.clearTimer();
    if (this.peeking) {
      this.peeking = false;
      this.handlers.leaveMap();
      return;
    }
    this.handlers.toggleMap();
  }

  /**
   * The window lost focus mid-hold. A keyup will never arrive, so end the look rather than
   * stranding somebody in the Map they never asked to travel to.
   */
  abort(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.clearTimer();
    if (!this.peeking) return;
    this.peeking = false;
    this.handlers.leaveMap();
  }

  private clearTimer(): void {
    if (this.handle === null) return;
    this.handlers.cancel(this.handle);
    this.handle = null;
  }
}

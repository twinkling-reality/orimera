/**
 * Mouse-look under Pointer Lock, and the three things the specification takes away from us.
 *
 * 1. THERE IS NO CURSOR POSITION WHILE LOCKED. Pointer Lock 2.0: `clientX`/`clientY` and
 *    `screenX`/`screenY` "must hold constant values as if the pointer did not move at all once
 *    pointer lock was entered", while `movementX`/`movementY` have no limit.
 *    https://w3c.github.io/pointerlock/  (interaction-model.md 2.1, VERIFIED)
 *    This file therefore reads `movementX` and `movementY` and NOTHING ELSE from the event. Any
 *    world targeting is at fixed screen centre, in the focus solver, from the camera forward
 *    vector. There is no hover in this product and there cannot be one.
 *
 * 2. WE CAN NEVER OWN THE ESCAPE KEY. "A default unlock gesture must always be available that
 *    will exit pointer lock", the specification recommends Escape, and the browser handles it.
 *    So Escape has exactly one meaning everywhere in Orimera: release the mouse. Nothing here
 *    binds it, and there is deliberately no keydown listener for it to be added to.
 *
 * 3. WE CAN NEVER AUTO-RELOCK. Re-locking after a user-initiated unlock requires an engagement
 *    gesture, so `requestLock` must be called from a real user gesture. This class exposes it
 *    and never calls it itself, not even on a `pointerlockerror`, because a retry loop against a
 *    transient-activation requirement is a spin, not a recovery.
 *    https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API
 */

export type InputMode = 'traverse' | 'converse';
export type TurnMode = 'smooth' | 'snap';

export interface LookSettings {
  /** Radians of yaw per pixel of raw movement, before the user's sensitivity multiplier. */
  radiansPerPixel: number;
  sensitivity: number;
  turnMode: TurnMode;
  /** Snap increment in degrees. interaction-model.md 2.4 fixes 30. */
  snapDegrees: number;
  invertY: boolean;
}

export const DEFAULT_LOOK: LookSettings = {
  radiansPerPixel: 0.0022,
  sensitivity: 1,
  turnMode: 'smooth',
  snapDegrees: 30,
  invertY: false,
};

/**
 * "Pitch range is nearly full (a small epsilon short of straight up and straight down) because
 * the user must be able to look up at overhead connection threads." (interaction-model.md 2.3)
 */
const PITCH_LIMIT = Math.PI / 2 - 0.02;

export class PointerLook {
  /** Yaw in the three.js convention: 0 looks down -Z. See `atlasForwardYaw`. */
  yaw = 0;
  pitch = 0;
  mode: InputMode = 'converse';
  settings: LookSettings = { ...DEFAULT_LOOK };

  /** True when the browser last told us the pointer is locked. Never inferred, always observed. */
  private locked = false;
  private snapAccumulator = 0;
  private readonly listeners = new Set<(mode: InputMode) => void>();
  private rawInputGranted: boolean | null = null;

  constructor(private readonly element: HTMLElement) {
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  /** Whether `unadjustedMovement` was granted. null until the first lock attempt resolves. */
  get rawInput(): boolean | null {
    return this.rawInputGranted;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  onModeChange(fn: (mode: InputMode) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * MUST be called from a user gesture. Raw input is requested where the browser offers it and
   * the failure is swallowed rather than surfaced (interaction-model.md 2.3: "falling back
   * silently rather than surfacing an error").
   */
  async requestLock(): Promise<void> {
    const el = this.element as HTMLElement & {
      requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
    };
    try {
      const result = el.requestPointerLock({ unadjustedMovement: true });
      if (result instanceof Promise) await result;
      this.rawInputGranted = true;
    } catch {
      this.rawInputGranted = false;
      try {
        const fallback = el.requestPointerLock();
        if (fallback instanceof Promise) await fallback;
      } catch {
        // Nothing to do and nothing to say. The resume affordance stays on screen.
      }
    }
  }

  private readonly onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    const next: InputMode = this.locked ? 'traverse' : 'converse';
    if (next !== this.mode) {
      this.mode = next;
      for (const fn of this.listeners) fn(next);
    }
  };

  private readonly onLockError = (): void => {
    // Observed and dropped. See point 3 above: no retry.
    this.locked = false;
    if (this.mode !== 'converse') {
      this.mode = 'converse';
      for (const fn of this.listeners) fn('converse');
    }
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    const s = this.settings;
    const step = s.radiansPerPixel * s.sensitivity;

    if (s.turnMode === 'snap') {
      // Snap turning for comfort-sensitive and keyboard-only users (interaction-model.md 2.4,
      // 9). Pitch stays smooth: vertical snap has no comfort benefit and loses the ability to
      // look up at an overhead thread.
      this.snapAccumulator += event.movementX * step;
      const increment = (s.snapDegrees * Math.PI) / 180;
      while (Math.abs(this.snapAccumulator) >= increment) {
        this.yaw -= Math.sign(this.snapAccumulator) * increment;
        this.snapAccumulator -= Math.sign(this.snapAccumulator) * increment;
      }
    } else {
      this.yaw -= event.movementX * step;
    }

    this.pitch -= (s.invertY ? -event.movementY : event.movementY) * step;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  };

  /**
   * The yaw to hand `forwardFromYawPitch` in atlas-core.
   *
   * three.js with rotation order YXZ looks down -Z at yaw 0; atlas-core's `forwardFromYawPitch`
   * returns `(sin y, sin p, cos y)`, which looks down +Z at yaw 0. The two differ by exactly pi.
   * Converting here rather than reimplementing the formula keeps one definition of the reticle
   * direction: the solver and the camera can never drift apart by a sign.
   */
  atlasForwardYaw(): number {
    return this.yaw + Math.PI;
  }

  dispose(): void {
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.listeners.clear();
  }
}

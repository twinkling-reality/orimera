import type { AtlasVec3 } from '@orimera/atlas-core';
import { forwardFromYawPitch } from '@orimera/atlas-core';

/**
 * First-person controls: pointer-lock mouse-look plus WASD, and a reticle at fixed screen centre.
 *
 * THE ONE FACT THAT SHAPES THIS FILE. Pointer Lock 2.0 states that while locked,
 * `clientX`/`clientY` and `screenX`/`screenY` "must hold constant values as if the pointer did not
 * move at all once pointer lock was entered", while `movementX`/`movementY` have no limit.
 * https://w3c.github.io/pointerlock/
 *
 * So there is no cursor to hover with and targeting is reticle-based, at screen centre, always.
 * This module therefore never reads a cursor position and never exposes one. It publishes a yaw
 * and a pitch, and the focus solver turns those into a forward vector. Any future code that wants
 * to hover a world object with the mouse is unimplementable and should be rejected here.
 *
 * THE SECOND FACT. The same specification requires that "a default unlock gesture must always be
 * available that will exit pointer lock", recommends Escape, and exits lock when the window loses
 * focus; re-locking after a user-initiated unlock needs a fresh engagement gesture.
 * https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API
 *
 * So the application never binds Escape, never calls `requestPointerLock` outside a real user
 * gesture, and never auto-relocks. It observes `pointerlockchange` and follows. The two input
 * modes in the interaction model, `traverse` and `converse`, are therefore a READ of the browser's
 * lock state rather than a state this module owns.
 *
 * NO JUMP VERB. The space bar is Interact. That is a product decision, not an omission.
 */

export type InputMode = 'traverse' | 'converse';

export interface ControlsConfig {
  readonly sensitivity: number;
  readonly moveSpeed: number;
  readonly sprintMultiplier: number;
  /** Critically damped acceleration ramp, in seconds to reach most of the target velocity. */
  readonly accelTime: number;
  readonly eyeHeight: number;
}

export const DEFAULT_CONTROLS: ControlsConfig = Object.freeze({
  sensitivity: 0.0022,
  moveSpeed: 9,
  sprintMultiplier: 2.6,
  accelTime: 0.12,
  eyeHeight: 1.62,
});

/** A small epsilon short of straight up and straight down: the user must be able to look at threads. */
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export interface CameraState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export class FirstPersonControls {
  readonly state: CameraState;

  private readonly canvas: HTMLCanvasElement;
  private readonly config: ControlsConfig;
  private readonly keys = new Set<string>();
  private vx = 0;
  private vz = 0;
  private locked = false;
  private disposers: Array<() => void> = [];

  /** Fired when the browser's lock state changes. The application follows; it never drives. */
  onModeChange: ((mode: InputMode) => void) | null = null;
  /** Interact. Bound to space, E, Enter and left click, exactly as the two-verb set requires. */
  onInteract: (() => void) | null = null;
  /** Summon Companion. Bound to C and right click. */
  onSummon: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, start: CameraState, config = DEFAULT_CONTROLS) {
    this.canvas = canvas;
    this.config = config;
    this.state = { ...start };

    const on = <K extends keyof DocumentEventMap>(
      target: Document | HTMLElement | Window,
      type: K | string,
      handler: (e: never) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener));
    };

    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys.clear();
      this.onModeChange?.(this.locked ? 'traverse' : 'converse');
    });

    on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.locked) return;
      // movementX/movementY only. clientX/clientY are frozen by the specification.
      this.state.yaw -= e.movementX * this.config.sensitivity;
      this.state.pitch -= e.movementY * this.config.sensitivity;
      this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.state.pitch));
    });

    on(canvas, 'mousedown', (e: MouseEvent) => {
      if (!this.locked) {
        // A real user gesture, which is the only thing that may request the lock.
        void this.canvas.requestPointerLock();
        return;
      }
      if (e.button === 0) this.onInteract?.();
      if (e.button === 2) this.onSummon?.();
    });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());

    on(window, 'keydown', (e: KeyboardEvent) => {
      // Escape is never bound. It has exactly one meaning everywhere: release the mouse, and the
      // browser owns it. Reading it here at all would be a bug.
      if (e.code === 'Escape') return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'Enter') {
        e.preventDefault();
        this.onInteract?.();
      }
      if (e.code === 'KeyC') this.onSummon?.();
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
  }

  get mode(): InputMode {
    return this.locked ? 'traverse' : 'converse';
  }

  /** Advance by `dt` seconds. Movement is disabled in `converse`, per the input mode table. */
  update(dt: number): void {
    let ix = 0;
    let iz = 0;
    if (this.locked) {
      if (this.keys.has('KeyW')) iz += 1;
      if (this.keys.has('KeyS')) iz -= 1;
      if (this.keys.has('KeyA')) ix -= 1;
      if (this.keys.has('KeyD')) ix += 1;
    }
    const len = Math.hypot(ix, iz);
    if (len > 0) {
      ix /= len;
      iz /= len;
    }

    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = this.config.moveSpeed * (sprint ? this.config.sprintMultiplier : 1);

    // Critically damped ramp. An instant velocity step reads as a teleport and is a comfort cost.
    const k = 1 - Math.exp(-dt / Math.max(this.config.accelTime, 1e-4));
    this.vx += (ix * speed - this.vx) * k;
    this.vz += (iz * speed - this.vz) * k;

    // Forward is -Z at yaw 0, the convention both candidate engines share, so a yaw of y gives
    // forward = (-sin y, 0, -cos y) and right = (cos y, 0, -sin y).
    const s = Math.sin(this.state.yaw);
    const c = Math.cos(this.state.yaw);
    this.state.x += (this.vz * -s + this.vx * c) * dt;
    this.state.z += (this.vz * -c - this.vx * s) * dt;
    this.state.y = this.config.eyeHeight;
  }

  /** The reticle direction. Screen centre, always. */
  forward(): AtlasVec3 {
    // atlas-core's convention: yaw 0 looks along +Z in its own basis. The camera's -Z forward is
    // the same ray with the yaw measured from the opposite pole, which is the single negation
    // below rather than a scattered set of sign flips.
    return forwardFromYawPitch(this.state.yaw + Math.PI, this.state.pitch);
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

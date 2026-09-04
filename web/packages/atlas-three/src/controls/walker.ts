import type { Island } from '@exulanica/atlas-core';
import type { OccupancyGrid } from '../containment.js';
import { atlasGroundToIslandGrid, sampleGround } from '../containment.js';
import type { PointerLook } from './pointer-look.js';

/**
 * The walker: WASD, a critically damped ramp, a sprint modifier, and NO JUMP.
 *
 * interaction-model.md 2.3 rejects a jump verb outright and the reasons are not aesthetic:
 * every anchor is authored into an eye-height band so nothing needs vertical reach; airborne
 * camera motion is uncontrolled vertical optic flow at zero information gain; and the space bar
 * is worth far more as Interact. The replacements are automatic step assist, near-full pitch,
 * and the Atlas Map. There is therefore no vertical velocity in this file at all, which is the
 * strongest way to keep a jump from being added back by accident.
 *
 * Containment is layered, because no single layer is sufficient for a point cloud:
 *
 *   Layer 1, the occupancy grid (see `containment.ts`). Coarse, derived, per island. It decides
 *           the floor height and refuses lateral moves into a wall, into water, or into a column
 *           the camera never observed.
 *   Layer 2, an authored soft boundary. A radius around the atlas centroid, sized from the
 *           layout, past which forward velocity is damped rather than stopped. ADR-0003 fixes
 *           this layer as required regardless of which engine wins, and it is what stops a user
 *           walking to infinity through empty between-space where layer 1 has nothing to say.
 *
 * Blocked lateral moves slide along the free axis rather than stopping dead, because a hard stop
 * against an invisible boundary in a first-person view reads as a bug.
 */

export interface WalkSettings {
  /** Metres per second at full ramp. */
  walkSpeed: number;
  sprintMultiplier: number;
  /** Seconds to reach ~63% of target speed. Critically damped, so no overshoot and no slide. */
  rampSeconds: number;
  eyeHeight: number;
  /** Largest floor rise the step assist absorbs in one move, metres. */
  stepUp: number;
  /** How fast the camera height follows the floor. Seconds to ~63%. */
  heightSpringSeconds: number;
  /** Atlas units. Past this the world is empty and the boundary damps forward motion. */
  softBoundaryRadius: number;
  softBoundaryWidth: number;
}

export const DEFAULT_WALK: WalkSettings = {
  walkSpeed: 3.4,
  sprintMultiplier: 2.4,
  rampSeconds: 0.14,
  eyeHeight: 1.62,
  stepUp: 0.45,
  heightSpringSeconds: 0.09,
  softBoundaryRadius: 260,
  softBoundaryWidth: 40,
};

export interface IslandGround {
  readonly island: Island;
  readonly grid: OccupancyGrid;
}

export interface WalkerFrame {
  /** 0..1. How hard the boundary is pushing back. Drives the comfort vignette. */
  readonly boundaryPressure: number;
  /** 0..1 of maximum speed. Drives the vignette on move (interaction-model.md 2.4). */
  readonly speedFraction: number;
  /** True when the walker is over unobserved or blocked ground and is being held back. */
  readonly held: boolean;
}

const KEYS = {
  forward: new Set(['KeyW', 'ArrowUp']),
  back: new Set(['KeyS', 'ArrowDown']),
  left: new Set(['KeyA']),
  right: new Set(['KeyD']),
  sprint: new Set(['ShiftLeft', 'ShiftRight']),
} as const;

export class Walker {
  x = 0;
  y = DEFAULT_WALK.eyeHeight;
  z = 0;
  settings: WalkSettings = { ...DEFAULT_WALK };

  private vx = 0;
  private vz = 0;
  private floorY = 0;
  private readonly pressed = new Set<string>();
  /** Arrow left/right turn the camera for keyboard-only users; they are not strafe. */
  private turn = 0;

  constructor(private readonly look: PointerLook) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Escape is not in this switch and must never be. The browser owns it (see PointerLook).
    if (e.code === 'ArrowLeft') this.turn = 1;
    else if (e.code === 'ArrowRight') this.turn = -1;
    this.pressed.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'ArrowLeft' && this.turn === 1) this.turn = 0;
    if (e.code === 'ArrowRight' && this.turn === -1) this.turn = 0;
    this.pressed.delete(e.code);
  };

  /** A blurred window keeps no keys down. Otherwise the user returns to a walker already moving. */
  private readonly onBlur = (): void => {
    this.pressed.clear();
    this.turn = 0;
  };

  placeAt(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.floorY = y - this.settings.eyeHeight;
    this.vx = 0;
    this.vz = 0;
  }

  private any(set: ReadonlySet<string>): boolean {
    for (const code of set) if (this.pressed.has(code)) return true;
    return false;
  }

  /**
   * Sample every island's occupancy grid at an atlas ground position and take the highest
   * supporting floor. Highest, because two islands may overlap in atlas space and the user is
   * standing on whichever is on top; that is a presentation fact and nothing reads it as one
   * about the world.
   */
  private ground(grounds: readonly IslandGround[], x: number, z: number): {
    floorY: number | null;
    passable: boolean;
  } {
    let best: number | null = null;
    let passable = true;
    let sawAny = false;
    for (const { island, grid } of grounds) {
      const local = atlasGroundToIslandGrid(island, x, z);
      const s = sampleGround(grid, local.x, local.z);
      if (s.floorY === null && !s.passable) {
        // Water, or a column the camera never observed. Inside the footprint that is a refusal.
        const r = Math.hypot(local.x, local.z);
        if (r <= island.footprintRadiusLocal) {
          sawAny = true;
          passable = false;
        }
        continue;
      }
      if (s.floorY === null) continue;
      sawAny = true;
      if (!s.passable) passable = false;
      const atlasY = island.placement.position.y + s.floorY * island.placement.scale;
      if (best === null || atlasY > best) best = atlasY;
    }
    // Between-space: no island has anything to say, so the walker is on the abstract ground
    // plane at y = 0 and layer 2 is the only containment.
    if (!sawAny) return { floorY: 0, passable: true };
    return { floorY: best, passable };
  }

  update(dtSeconds: number, grounds: readonly IslandGround[]): WalkerFrame {
    const s = this.settings;
    const dt = Math.min(0.1, dtSeconds);

    if (this.turn !== 0) this.look.yaw += this.turn * 1.9 * dt;

    let ix = 0;
    let iz = 0;
    if (this.look.mode === 'traverse' || this.turn !== 0 || this.pressed.size > 0) {
      if (this.any(KEYS.forward)) iz -= 1;
      if (this.any(KEYS.back)) iz += 1;
      if (this.any(KEYS.left)) ix -= 1;
      if (this.any(KEYS.right)) ix += 1;
    }
    const len = Math.hypot(ix, iz);
    if (len > 0) {
      ix /= len;
      iz /= len;
    }

    const speed = s.walkSpeed * (this.any(KEYS.sprint) ? s.sprintMultiplier : 1);
    const yaw = this.look.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // three.js YXZ: forward is (-sin, -cos) on the ground plane, right is (cos, -sin).
    const targetX = (ix * cos + iz * -sin) * speed;
    const targetZ = (ix * -sin + iz * -cos) * speed;

    // Critically damped first-order ramp. Exact rather than an Euler step, so the feel does not
    // change with frame rate, which matters when the whole point of the harness is to vary it.
    const k = 1 - Math.exp(-dt / Math.max(0.001, s.rampSeconds));
    this.vx += (targetX - this.vx) * k;
    this.vz += (targetZ - this.vz) * k;

    // Layer 2: the authored soft boundary.
    const r = Math.hypot(this.x, this.z);
    let boundaryPressure = 0;
    if (r > s.softBoundaryRadius) {
      boundaryPressure = Math.min(1, (r - s.softBoundaryRadius) / s.softBoundaryWidth);
      const outward = (this.vx * this.x + this.vz * this.z) / Math.max(0.001, r);
      if (outward > 0) {
        const damp = 1 - boundaryPressure;
        this.vx -= (this.x / r) * outward * (1 - damp);
        this.vz -= (this.z / r) * outward * (1 - damp);
      }
    }

    // Layer 1: try the move, per axis, so a blocked direction slides instead of stopping.
    let held = false;
    const tryX = this.x + this.vx * dt;
    const tryZ = this.z + this.vz * dt;

    const gx = this.ground(grounds, tryX, this.z);
    const okX = gx.passable && gx.floorY !== null && gx.floorY - this.floorY <= s.stepUp;
    const gz = this.ground(grounds, this.x, tryZ);
    const okZ = gz.passable && gz.floorY !== null && gz.floorY - this.floorY <= s.stepUp;

    if (okX) this.x = tryX;
    else {
      this.vx = 0;
      held = true;
    }
    if (okZ) this.z = tryZ;
    else {
      this.vz = 0;
      held = true;
    }

    const here = this.ground(grounds, this.x, this.z);
    if (here.floorY !== null) {
      // Step assist: absorb a rise up to `stepUp` in one move; fall at the spring rate.
      const target = here.floorY;
      const hk = 1 - Math.exp(-dt / Math.max(0.001, s.heightSpringSeconds));
      this.floorY += (target - this.floorY) * hk;
    }
    this.y = this.floorY + s.eyeHeight;

    const speedFraction = Math.min(1, Math.hypot(this.vx, this.vz) / (s.walkSpeed * s.sprintMultiplier));
    return { boundaryPressure, speedFraction, held };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}

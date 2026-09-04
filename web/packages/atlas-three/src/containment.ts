import type { Island } from '@exulanica/atlas-core';
import type { PointMapData } from './opm.js';

/**
 * CONTAINMENT FOR A SUBSTRATE WITH NO COLLISION MESH.
 *
 * A point map is not a surface. There is nothing to raycast against that is not either wrong
 * (nearest point, which lets you stand inside a wall as long as you are between two samples) or
 * ruinous (a per-frame kNN over four million points). ADR-0003 already fixed the answer for the
 * product: "Containment is spline-constrained camera rigs plus authored soft boundary volumes.
 * Splat-derived collision is an optional bonus only if `-K` survives a real capture." What
 * follows is the cheap, derived half of that: a coarse occupancy grid computed once at load.
 *
 * Three grids over the island's local XZ plane, built in ONE linear pass over the positions:
 *
 *   floor        the lowest supporting surface in the column. `min`, not `max`, because the
 *                maximum is a roof or a mast and would teleport the walker onto the skyline.
 *   obstruction  how many points sit in the body band, floor+0.4 to floor+1.9 metres. A wall,
 *                a crate or a moored hull all read as a high count; open air reads as zero.
 *   support      how many supporting points the column has at all. Zero means unobserved, and
 *                unobserved is not the same as empty: the walker refuses to enter rather than
 *                falling through, because the camera never saw what is there.
 *
 * Segment class decides what counts. `ground` and `structure` support; `water` blocks outright,
 * so the user cannot stroll into the harbour; `object` obstructs but does not support; `person`
 * is ignored entirely, because people are citations rather than geometry and a presence marker
 * must never become a wall.
 *
 * The pass is deliberately NOT run before the first frame. Time to first meaningful render is a
 * number the bake-off reports, and burying a 4M-element loop inside it would measure this file
 * instead of the renderer. It runs on the frame after, and its cost is reported separately.
 */

export const GRID_RESOLUTION = 160;
const BODY_LOW = 0.4;
const BODY_HIGH = 1.9;
/** Cells with fewer supporting points than this are unobserved, not empty. */
const MIN_SUPPORT = 3;
/** Points per cell in the body band above which the cell is impassable. */
const OBSTRUCTION_LIMIT = 12;

type SegmentRole = 'support' | 'block' | 'obstruct' | 'ignore';

function roleOf(cls: string): SegmentRole {
  switch (cls) {
    case 'ground':
    case 'structure':
      return 'support';
    case 'water':
      return 'block';
    case 'object':
    case 'vegetation':
      return 'obstruct';
    default:
      return 'ignore';
  }
}

export interface OccupancyGrid {
  readonly resolution: number;
  /** Half-extent in local units. The grid covers [-extent, extent] on both X and Z. */
  readonly extent: number;
  readonly floor: Float32Array;
  readonly obstruction: Uint16Array;
  readonly support: Uint16Array;
  /** True where the column is water. Blocks regardless of obstruction count. */
  readonly blocked: Uint8Array;
  readonly buildMs: number;
}

export function buildOccupancyGrid(data: PointMapData, extent: number): OccupancyGrid {
  const t0 = performance.now();
  const n = GRID_RESOLUTION;
  const cells = n * n;
  const floor = new Float32Array(cells).fill(Number.POSITIVE_INFINITY);
  const support = new Uint16Array(cells);
  const blocked = new Uint8Array(cells);
  const obstruction = new Uint16Array(cells);

  const roles = new Uint8Array(256);
  const ROLE = { support: 1, block: 2, obstruct: 3, ignore: 0 } as const;
  for (const s of data.header.segments) roles[s.id] = ROLE[roleOf(s.cls)];

  const pos = data.position;
  const tags = data.tags;
  const count = data.header.pointCount;
  const inv = n / (2 * extent);

  // Pass 1: floor, support and water, per column.
  for (let i = 0; i < count; i += 1) {
    // Channel 0 of the tags attribute. Channel 1 is the flags word and has no bearing on
    // containment: a point beside a silhouette drop still stands where it stands.
    const role = roles[tags[i * 2]!]!;
    if (role === ROLE.ignore) continue;
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    const gx = ((x + extent) * inv) | 0;
    const gz = ((z + extent) * inv) | 0;
    if (gx < 0 || gx >= n || gz < 0 || gz >= n) continue;
    const c = gz * n + gx;
    if (role === ROLE.block) {
      blocked[c] = 1;
      continue;
    }
    if (role === ROLE.support) {
      if (y < floor[c]!) floor[c] = y;
      if (support[c]! < 65535) support[c] = support[c]! + 1;
    }
  }

  // Pass 2: the body band. A second pass rather than a second grid keyed on an unknown floor.
  for (let i = 0; i < count; i += 1) {
    // Channel 0 of the tags attribute. Channel 1 is the flags word and has no bearing on
    // containment: a point beside a silhouette drop still stands where it stands.
    const role = roles[tags[i * 2]!]!;
    if (role !== ROLE.support && role !== ROLE.obstruct) continue;
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    const gx = ((x + extent) * inv) | 0;
    const gz = ((z + extent) * inv) | 0;
    if (gx < 0 || gx >= n || gz < 0 || gz >= n) continue;
    const c = gz * n + gx;
    const f = floor[c]!;
    if (!Number.isFinite(f)) continue;
    if (y > f + BODY_LOW && y < f + BODY_HIGH && obstruction[c]! < 65535) {
      obstruction[c] = obstruction[c]! + 1;
    }
  }

  return Object.freeze({
    resolution: n,
    extent,
    floor,
    obstruction,
    support,
    blocked,
    buildMs: performance.now() - t0,
  });
}

export interface GroundSample {
  /** Local Y of the supporting surface, or null when the column is unobserved or blocked. */
  readonly floorY: number | null;
  readonly passable: boolean;
}

/**
 * Sample the grid at a LOCAL x/z.
 *
 * Takes raw numbers, not a `LocalVec3`, and returns raw numbers. That is not laziness: the
 * caller reaches this by inverting an island placement, and an island's atlas position carries
 * no real-world meaning (interaction-model.md 1.2, risk R-48). Keeping the inverse un-branded
 * means nothing here can be mistaken for a measurement, and there is still no `atlasToLocal` in
 * atlas-core for anything else to reach for.
 */
export function sampleGround(grid: OccupancyGrid, x: number, z: number): GroundSample {
  const n = grid.resolution;
  const gx = (((x + grid.extent) * n) / (2 * grid.extent)) | 0;
  const gz = (((z + grid.extent) * n) / (2 * grid.extent)) | 0;
  if (gx < 0 || gx >= n || gz < 0 || gz >= n) return { floorY: null, passable: true };
  const c = gz * n + gx;
  if (grid.blocked[c] === 1) return { floorY: null, passable: false };
  if (grid.support[c]! < MIN_SUPPORT) return { floorY: null, passable: false };
  const f = grid.floor[c]!;
  if (!Number.isFinite(f)) return { floorY: null, passable: false };
  return { floorY: f, passable: grid.obstruction[c]! < OBSTRUCTION_LIMIT };
}

/**
 * The inverse of `localToAtlas`, restricted to the ground plane and to plain numbers.
 *
 * atlas-core deliberately exports no `atlasToLocal`, and it is right not to: going back would
 * let a caller launder a presentational position into an answer about the world. A renderer
 * choosing which grid cell the camera stands over is not that caller. The restriction to a
 * `{x, z}` pair with no frame brand is the guard: there is nothing here to pass to a query.
 */
export function atlasGroundToIslandGrid(
  island: Island,
  atlasX: number,
  atlasZ: number,
): { x: number; z: number } {
  const p = island.placement;
  const dx = (atlasX - p.position.x) / p.scale;
  const dz = (atlasZ - p.position.z) / p.scale;
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  // Inverse of [x*c + z*s, -x*s + z*c].
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

export const CONTAINMENT_CONSTANTS = Object.freeze({
  GRID_RESOLUTION,
  BODY_LOW,
  BODY_HIGH,
  MIN_SUPPORT,
  OBSTRUCTION_LIMIT,
});

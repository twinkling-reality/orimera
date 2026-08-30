import type { AtlasVec3 } from './coords.js';
import { atlasVec3 } from './coords.js';
import type { AnchorId, IslandId } from './ids.js';
import {
  isNavigationLineVisible,
  isNavigationPathClear,
  isNavigationPositionClear,
  type NavigationPose,
  type NavigationWorld,
} from './navigation.js';
import type { AtlasScene } from './scene.js';
import { anchorAtlasPosition, buildAnchorTable } from './scene.js';

export const DIRECT_NAVIGATION_DURATION_MS = 1200;

export type DirectNavigationTarget =
  | { readonly kind: 'island'; readonly islandId: IslandId }
  | { readonly kind: 'anchor'; readonly anchorId: AnchorId };

export type DirectNavigationFailureReason =
  | 'unknown-target'
  | 'outside-resident-field'
  | 'no-safe-surface'
  | 'occluded';

export type DirectNavigationResolution =
  | {
      readonly ok: true;
      readonly target: DirectNavigationTarget;
      readonly islandId: IslandId;
      readonly pose: NavigationPose;
      readonly targetPosition: AtlasVec3;
    }
  | {
      readonly ok: false;
      readonly target: DirectNavigationTarget;
      readonly reason: DirectNavigationFailureReason;
    };

export interface DirectNavigationTransition {
  readonly target: DirectNavigationTarget;
  readonly islandId: IslandId;
  readonly from: NavigationPose;
  readonly to: NavigationPose;
  readonly durationMs: number;
}

const groundDistance = (a: AtlasVec3, b: AtlasVec3): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

function poseLookingAt(position: AtlasVec3, target: AtlasVec3): NavigationPose {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const horizontal = Math.max(Math.hypot(dx, dz), 1e-9);
  return Object.freeze({
    position,
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, horizontal),
  });
}

function candidateAngles(target: AtlasVec3, current: AtlasVec3): readonly number[] {
  const dx = current.x - target.x;
  const dz = current.z - target.z;
  const base = Math.hypot(dx, dz) < 1e-6 ? Math.PI / 2 : Math.atan2(dz, dx);
  return Object.freeze([
    base,
    base + Math.PI / 4,
    base - Math.PI / 4,
    base + Math.PI / 2,
    base - Math.PI / 2,
    base + (3 * Math.PI) / 4,
    base - (3 * Math.PI) / 4,
    base + Math.PI,
  ]);
}

function safePoseAround(
  world: NavigationWorld,
  target: AtlasVec3,
  current: AtlasVec3,
  distance: number,
  requireLineOfSight: boolean,
): NavigationPose | null {
  for (const angle of candidateAngles(target, current)) {
    const x = target.x + Math.cos(angle) * distance;
    const z = target.z + Math.sin(angle) * distance;
    if (Math.hypot(x - world.centre.x, z - world.centre.z) > world.fieldRadius) continue;
    const sample = world.surface.sample(x, z);
    if (sample === null) continue;
    const position = atlasVec3(x, sample.height + world.eyeHeight, z);
    if (!isNavigationPositionClear(world, position)) continue;
    if (!isNavigationPathClear(world, current, position)) continue;
    if (requireLineOfSight && !isNavigationLineVisible(world, position, target)) continue;
    return poseLookingAt(position, target);
  }
  return null;
}

/** Resolve a deterministic safe region entry or exact anchor vantage inside the resident field. */
export function resolveDirectNavigation(
  scene: AtlasScene,
  world: NavigationWorld,
  target: DirectNavigationTarget,
  current: AtlasVec3,
): DirectNavigationResolution {
  if (target.kind === 'island') {
    const island = scene.islands.find((value) => value.islandId === target.islandId);
    if (island === undefined) return Object.freeze({ ok: false, target, reason: 'unknown-target' });
    const region = world.regions.find((value) => value.islandId === target.islandId);
    if (region === undefined) {
      return Object.freeze({ ok: false, target, reason: 'outside-resident-field' });
    }
    const sample = world.surface.sample(region.centre.x, region.centre.z);
    const targetPosition = atlasVec3(
      region.centre.x,
      (sample?.height ?? region.centre.y) + world.eyeHeight * 0.45,
      region.centre.z,
    );
    const distance = Math.max(1, Math.min(region.footprintRadius * 0.55, region.footprintRadius - 0.8));
    const pose = safePoseAround(world, targetPosition, current, distance, false);
    return pose === null
      ? Object.freeze({ ok: false, target, reason: 'no-safe-surface' })
      : Object.freeze({ ok: true, target, islandId: island.islandId, pose, targetPosition });
  }

  const table = buildAnchorTable(scene);
  const index = table.indexOf.get(target.anchorId);
  if (index === undefined) return Object.freeze({ ok: false, target, reason: 'unknown-target' });
  const anchor = table.anchors[index]!;
  const island = scene.islands.find((value) => value.islandId === anchor.islandId);
  const region = world.regions.find((value) => value.islandId === anchor.islandId);
  if (island === undefined || region === undefined) {
    return Object.freeze({ ok: false, target, reason: 'outside-resident-field' });
  }
  const targetPosition = anchorAtlasPosition(table, index);
  const distance = Math.max(2.4, table.focusRadii[index]! + 1.8);
  const pose = safePoseAround(world, targetPosition, current, distance, true);
  if (pose !== null) {
    return Object.freeze({ ok: true, target, islandId: island.islandId, pose, targetPosition });
  }
  // Distinguish a missing surface from an occluded target for truthful recovery copy.
  const hasSurfaceCandidate = candidateAngles(targetPosition, current).some((angle) => {
    const x = targetPosition.x + Math.cos(angle) * distance;
    const z = targetPosition.z + Math.sin(angle) * distance;
    return world.surface.sample(x, z) !== null &&
      groundDistance(atlasVec3(x, 0, z), world.centre) <= world.fieldRadius;
  });
  return Object.freeze({
    ok: false,
    target,
    reason: hasSurfaceCandidate ? 'occluded' : 'no-safe-surface',
  });
}

export function planDirectNavigationTransition(
  resolution: Extract<DirectNavigationResolution, { readonly ok: true }>,
  from: NavigationPose,
  reducedMotion: boolean,
): DirectNavigationTransition {
  return Object.freeze({
    target: resolution.target,
    islandId: resolution.islandId,
    from: Object.freeze({ ...from }),
    to: resolution.pose,
    durationMs: reducedMotion ? 0 : DIRECT_NAVIGATION_DURATION_MS,
  });
}

const shortestAngle = (from: number, to: number): number =>
  ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

/** Sample the same transition for rendering and tests. Endpoints are exact, not asymptotic. */
export function sampleDirectNavigationTransition(
  transition: DirectNavigationTransition,
  elapsedMs: number,
): NavigationPose {
  const raw = transition.durationMs === 0 ? 1 : Math.max(0, Math.min(1, elapsedMs / transition.durationMs));
  const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
  const from = transition.from;
  const to = transition.to;
  if (raw === 1) return to;
  if (raw === 0) return from;
  return Object.freeze({
    position: atlasVec3(
      from.position.x + (to.position.x - from.position.x) * t,
      from.position.y + (to.position.y - from.position.y) * t,
      from.position.z + (to.position.z - from.position.z) * t,
    ),
    yaw: from.yaw + shortestAngle(from.yaw, to.yaw) * t,
    pitch: from.pitch + (to.pitch - from.pitch) * t,
  });
}

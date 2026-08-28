import type { AtlasScene } from '@orimera/atlas-core';

/**
 * The scripted camera path, and why the bake-off cannot use a static camera.
 *
 * A still camera measures one frustum, one overdraw figure and one cull result. Point-cloud cost
 * is dominated by exactly those three things, so a static number would be a number about one
 * viewpoint rather than about the renderer. The path below is deterministic, identical at every
 * rung, and covers the three cases that actually differ:
 *
 *   A  dolly into the island, near field, maximum overdraw and maximum point size.
 *   B  a full rotation in place at mid-scene, so the whole cloud passes through the frustum and
 *      frustum culling gets no free wins.
 *   C  a retreat out past the footprint boundary into the between-space, looking back, so EVERY
 *      island is in view at once. This is the Atlas overview case and it is the one the
 *      cross-asset budget argument in ADR-0003 is really about.
 *
 * Being deterministic is the point: two renderer bindings compared on two different camera paths
 * have not been compared.
 */

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface PathContext {
  /** Atlas-space anchor for phase A and B: the first island's viewpoint. */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly islandYaw: number;
  readonly footprintAtlas: number;
}

export function pathContext(scene: AtlasScene): PathContext {
  const island = scene.islands[0]!;
  const p = island.placement;
  const v = island.viewpointLocal;
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return {
    originX: p.position.x + v.x * p.scale * c + v.z * p.scale * s,
    originY: p.position.y + v.y * p.scale,
    originZ: p.position.z - v.x * p.scale * s + v.z * p.scale * c,
    islandYaw: p.yaw,
    footprintAtlas: island.footprintRadiusLocal * p.scale,
  };
}

/**
 * @param t 0..1 through the measurement window.
 *
 * three.js YXZ convention: yaw 0 looks down -Z, so the island's own capture direction (local -Z)
 * is at `islandYaw`.
 */
export function poseAt(ctx: PathContext, t: number, out: Pose): Pose {
  const facing = ctx.islandYaw;

  if (t < 0.35) {
    // A. Dolly forward along the capture direction, sweeping the view across the near field.
    const u = t / 0.35;
    const dolly = u * 16;
    out.x = ctx.originX - Math.sin(facing) * dolly;
    out.z = ctx.originZ - Math.cos(facing) * dolly;
    out.y = ctx.originY;
    out.yaw = facing + Math.sin(u * Math.PI * 2) * 0.61;
    out.pitch = Math.sin(u * Math.PI) * -0.14;
    return out;
  }

  if (t < 0.7) {
    // B. A full rotation in place. Every point in the island crosses the frustum exactly once.
    const u = (t - 0.35) / 0.35;
    out.x = ctx.originX - Math.sin(facing) * 16;
    out.z = ctx.originZ - Math.cos(facing) * 16;
    out.y = ctx.originY;
    out.yaw = facing + u * Math.PI * 2;
    out.pitch = Math.sin(u * Math.PI * 2) * 0.28;
    return out;
  }

  // C. Retreat out through the dissolve band into the between-space, looking back at the Atlas.
  const u = (t - 0.7) / 0.3;
  const back = 16 - u * (ctx.footprintAtlas * 1.9 + 16);
  out.x = ctx.originX - Math.sin(facing) * back;
  out.z = ctx.originZ - Math.cos(facing) * back;
  out.y = ctx.originY + u * 22;
  out.yaw = facing + Math.sin(u * Math.PI) * 1.1;
  out.pitch = -u * 0.35;
  return out;
}

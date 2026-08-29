import { describe, expect, it } from 'vitest';
import type { AtlasVec3, PlacementConfig, PlacementInputs, ScreenRect } from '../src/index.js';
import { DEFAULT_PLACEMENT_CONFIG, atlasVec3, resolveCompanionPlacement } from '../src/index.js';

/**
 * These tests exist to fail if a rejection rule is quietly deleted.
 *
 * Each of the six rules in interaction-model.md 4.2 removes candidates that would otherwise score
 * well, so any of them can be dropped without breaking a single happy-path assertion. The
 * projection helper below re-derives screen position independently of the solver, which is what
 * makes "the reticle is never blocked" a property under test rather than a restatement of the
 * implementation.
 */

/** Lower left, matching the panel anchor in 4.1. */
const PANEL: ScreenRect = { minX: -1, minY: -1, maxX: -0.2, maxY: -0.1 };

const NOTHING_BLOCKS = (): boolean => true;
const EVERYTHING_BLOCKS = (): boolean => false;

const camera = (position: AtlasVec3, forward: AtlasVec3) => ({ position, forward });

function inputs(over: Partial<PlacementInputs> = {}): PlacementInputs {
  return {
    camera: camera(atlasVec3(0, 1.7, 0), atlasVec3(0, 0, -1)),
    subject: atlasVec3(0, 1.7, -8),
    panel: PANEL,
    visible: NOTHING_BLOCKS,
    obstacles: [],
    previous: null,
    ...over,
  };
}

/**
 * Independent projection. Deliberately not imported from the solver: if both sides shared one
 * implementation a sign error would cancel out and every screen-space assertion here would pass
 * against a Companion drawn in the wrong half of the view.
 */
function ndc(
  pos: AtlasVec3,
  camPos: AtlasVec3,
  fwd: AtlasVec3,
  cfg: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): { x: number; y: number; depth: number } {
  const d = { x: pos.x - camPos.x, y: pos.y - camPos.y, z: pos.z - camPos.z };
  const up = { x: 0, y: 1, z: 0 };
  const r = {
    x: fwd.y * up.z - fwd.z * up.y,
    y: fwd.z * up.x - fwd.x * up.z,
    z: fwd.x * up.y - fwd.y * up.x,
  };
  const rl = Math.hypot(r.x, r.y, r.z) || 1;
  const right = { x: r.x / rl, y: r.y / rl, z: r.z / rl };
  const u = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  const depth = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
  const tanH = Math.tan(cfg.hFovRad / 2);
  const tanV = tanH / cfg.aspect;
  return {
    x: (d.x * right.x + d.y * right.y + d.z * right.z) / (depth * tanH),
    y: (d.x * u.x + d.y * u.y + d.z * u.z) / (depth * tanV),
    depth,
  };
}

describe('the Companion never occupies a place the interface has reserved', () => {
  it('never projects over the reticle', () => {
    const r = resolveCompanionPlacement(inputs());
    expect(r.placement).not.toBeNull();
    const p = ndc(r.placement!.position, atlasVec3(0, 1.7, 0), atlasVec3(0, 0, -1));
    expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(DEFAULT_PLACEMENT_CONFIG.reticleClearNdc);
  });

  it('never projects inside the panel rectangle', () => {
    const r = resolveCompanionPlacement(inputs());
    const p = ndc(r.placement!.position, atlasVec3(0, 1.7, 0), atlasVec3(0, 0, -1));
    const inPanel = p.x >= PANEL.minX && p.x <= PANEL.maxX && p.y >= PANEL.minY && p.y <= PANEL.maxY;
    expect(inPanel).toBe(false);
  });

  it('never lands outside the frustum minus its margin', () => {
    const r = resolveCompanionPlacement(inputs());
    const p = ndc(r.placement!.position, atlasVec3(0, 1.7, 0), atlasVec3(0, 0, -1));
    const edge = 1 - DEFAULT_PLACEMENT_CONFIG.fovMargin;
    expect(Math.abs(p.x)).toBeLessThanOrEqual(edge);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(edge);
    expect(p.depth).toBeGreaterThan(0);
  });

  it('prefers the side opposite the panel', () => {
    const r = resolveCompanionPlacement(inputs());
    const p = ndc(r.placement!.position, atlasVec3(0, 1.7, 0), atlasVec3(0, 0, -1));
    // The panel is lower left, so a Companion on the left would force the user to read the
    // question through the thing the question is about.
    expect(p.x).toBeGreaterThan(0);
  });

  it('never stands closer to the camera than the minimum', () => {
    const r = resolveCompanionPlacement(inputs({ subject: atlasVec3(0, 1.7, -2) }));
    if (r.placement !== null) {
      const d = Math.hypot(r.placement.position.x, r.placement.position.z);
      expect(d).toBeGreaterThanOrEqual(DEFAULT_PLACEMENT_CONFIG.minCameraDistance - 1e-9);
    }
  });
});

describe('degradation is a value, not an error path', () => {
  it('returns a null placement rather than throwing when everything is occluded', () => {
    const r = resolveCompanionPlacement(inputs({ visible: EVERYTHING_BLOCKS }));
    expect(r.placement).toBeNull();
    expect(r.survivors).toBe(0);
    // The caller has to caption the absence. An untallied null would leave it inventing a reason.
    expect(r.rejection.occluded).toBeGreaterThan(0);
  });

  it('returns a null placement when the collision proxy covers the whole arc', () => {
    const wall = { position: atlasVec3(0, 1.7, -8), radius: 40 };
    const r = resolveCompanionPlacement(inputs({ obstacles: [wall] }));
    expect(r.placement).toBeNull();
    expect(r.rejection['inside-proxy']).toBeGreaterThan(0);
  });

  it('accounts for every candidate it swept', () => {
    const r = resolveCompanionPlacement(inputs({ visible: EVERYTHING_BLOCKS }));
    const rejected = Object.values(r.rejection).reduce((a, b) => a + b, 0);
    expect(rejected + r.survivors).toBe(DEFAULT_PLACEMENT_CONFIG.arcSamples);
  });
});

describe('the solve is deterministic', () => {
  it('returns the identical position for identical inputs', () => {
    const a = resolveCompanionPlacement(inputs());
    const b = resolveCompanionPlacement(inputs());
    expect(b.placement!.position).toEqual(a.placement!.position);
    expect(b.placement!.score).toBe(a.placement!.score);
  });

  it('is stable in the user frame as the camera orbits a fixed subject', () => {
    // Same relative geometry, rotated. The chosen bearing relative to the camera must not swing,
    // or the Companion would relocate every time the user walked round an anchor.
    const straight = resolveCompanionPlacement(inputs());
    const rotated = resolveCompanionPlacement(
      inputs({
        camera: camera(atlasVec3(8, 1.7, 0), atlasVec3(-1, 0, 0)),
        subject: atlasVec3(0, 1.7, 0),
      }),
    );
    const wrap = (a: number) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    const relative = (arc: number, camX: number, camZ: number, sx: number, sz: number) =>
      wrap(arc - Math.atan2(camX - sx, camZ - sz));
    expect(relative(rotated.placement!.arcAngle, 8, 0, 0, 0)).toBeCloseTo(
      relative(straight.placement!.arcAngle, 0, 0, 0, -8),
      6,
    );
  });
});

describe('the movement grammar follows 4.2', () => {
  it('assembles on first appearance', () => {
    const r = resolveCompanionPlacement(inputs({ previous: null }));
    expect(r.placement!.materialization).toBe('assemble');
  });

  it('glides for a small relocation', () => {
    const first = resolveCompanionPlacement(inputs());
    const near = atlasVec3(
      first.placement!.position.x + 0.4,
      first.placement!.position.y,
      first.placement!.position.z + 0.4,
    );
    const r = resolveCompanionPlacement(inputs({ previous: near }));
    expect(r.placement!.materialization).toBe('glide');
  });

  it('dissolves and reassembles rather than flying across the view', () => {
    const first = resolveCompanionPlacement(inputs());
    const far = atlasVec3(
      first.placement!.position.x - 30,
      first.placement!.position.y,
      first.placement!.position.z - 30,
    );
    const r = resolveCompanionPlacement(inputs({ previous: far }));
    expect(r.placement!.materialization).toBe('reassemble');
  });
});

describe('the subject fallback', () => {
  it('places against a point ahead of the camera when nothing is focused', () => {
    const r = resolveCompanionPlacement(inputs({ subject: null }));
    expect(r.placement).not.toBeNull();
    const p = ndc(r.placement!.position, atlasVec3(0, 1.7, 0), atlasVec3(0, 0, -1));
    expect(p.depth).toBeGreaterThan(0);
  });

  it('faces the subject', () => {
    const r = resolveCompanionPlacement(inputs());
    const { position, yaw } = r.placement!;
    // The yaw convention in coords.ts sends local -Z to (-sin yaw, 0, -cos yaw).
    const facing = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const toSubject = { x: 0 - position.x, z: -8 - position.z };
    const len = Math.hypot(toSubject.x, toSubject.z);
    expect(facing.x * (toSubject.x / len) + facing.z * (toSubject.z / len)).toBeCloseTo(1, 6);
  });
});

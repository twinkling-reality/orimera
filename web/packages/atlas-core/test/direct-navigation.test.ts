import { describe, expect, it } from 'vitest';
import {
  atlasVec3,
  buildNavigationWorld,
  islandId,
  planDirectNavigationTransition,
  resolveDirectNavigation,
  sampleDirectNavigationTransition,
} from '../src/index.js';
import { anchor, island, scene } from './fixture.js';

describe('direct navigation', () => {
  const memory = island({
    key: 'memory',
    createdAt: 1,
    footprint: 12,
    position: [8, 0, -4],
    anchors: [{ key: 'object', local: [1, 1, -2], radius: 0.4 }],
  });
  const atlas = scene([memory]);
  const world = buildNavigationWorld(atlas);

  it('resolves a safe interior region pose that looks toward the region', () => {
    const result = resolveDirectNavigation(
      atlas,
      world,
      { kind: 'island', islandId: islandId('memory') },
      atlasVec3(0, world.eyeHeight, 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.islandId).toBe(islandId('memory'));
    expect(result.pose.position.y).toBe(world.eyeHeight);
    expect(Math.hypot(
      result.pose.position.x - memory.placement.position.x,
      result.pose.position.z - memory.placement.position.z,
    )).toBeLessThan(memory.footprintRadiusLocal);
  });

  it('resolves an exact anchor vantage with line of sight', () => {
    const target = memory.anchors[0]!;
    const result = resolveDirectNavigation(
      atlas,
      world,
      { kind: 'anchor', anchorId: target.anchorId },
      atlasVec3(0, world.eyeHeight, 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetPosition).toEqual(atlasVec3(9, 1, -6));
  });

  it('rejects a target outside the resident scene instead of fabricating a pose', () => {
    expect(resolveDirectNavigation(
      atlas,
      world,
      { kind: 'island', islandId: islandId('not-resident') },
      atlasVec3(0, world.eyeHeight, 0),
    )).toEqual({
      ok: false,
      target: { kind: 'island', islandId: islandId('not-resident') },
      reason: 'unknown-target',
    });
  });

  it('rejects direct travel when a missing surface lies between two valid endpoints', () => {
    const discontinuous = buildNavigationWorld(atlas, {
      sample: (x) => x > 0.5 && x < 1.3
        ? null
        : { height: 0, normal: { x: 0, y: 1, z: 0 } },
    });
    expect(resolveDirectNavigation(
      atlas,
      discontinuous,
      { kind: 'island', islandId: islandId('memory') },
      atlasVec3(0, discontinuous.eyeHeight, 0),
    )).toEqual({
      ok: false,
      target: { kind: 'island', islandId: islandId('memory') },
      reason: 'no-safe-surface',
    });
  });

  it('samples exact transition endpoints and honors reduced motion', () => {
    const result = resolveDirectNavigation(
      atlas,
      world,
      { kind: 'anchor', anchorId: memory.anchors[0]!.anchorId },
      atlasVec3(0, world.eyeHeight, 0),
    );
    if (!result.ok) throw new Error('fixture should resolve');
    const from = { position: atlasVec3(0, world.eyeHeight, 0), yaw: Math.PI - 0.1, pitch: 0 };
    const transition = planDirectNavigationTransition(result, from, false);
    expect(sampleDirectNavigationTransition(transition, 0)).toEqual(from);
    expect(sampleDirectNavigationTransition(transition, transition.durationMs)).toBe(result.pose);
    const reduced = planDirectNavigationTransition(result, from, true);
    expect(sampleDirectNavigationTransition(reduced, 0)).toBe(result.pose);
  });

  it('does not depend on the source array order', () => {
    const second = island({ key: 'second', createdAt: 2, anchors: [] });
    const target = anchor('memory', { key: 'other', local: [0, 1, 0] });
    const withTarget = { ...memory, anchors: [...memory.anchors, target] };
    const a = scene([withTarget, second]);
    const b = scene([second, withTarget]);
    expect(resolveDirectNavigation(a, buildNavigationWorld(a), {
      kind: 'anchor', anchorId: target.anchorId,
    }, atlasVec3(0, 1.62, 0))).toEqual(resolveDirectNavigation(b, buildNavigationWorld(b), {
      kind: 'anchor', anchorId: target.anchorId,
    }, atlasVec3(0, 1.62, 0)));
  });
});

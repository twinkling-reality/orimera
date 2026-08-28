import { describe, expect, it } from 'vitest';
import * as atlasCore from '../src/index.js';
import {
  asMetricLocal,
  atlasVec3,
  localDistance,
  localToAtlas,
  localVec3,
  metricDistance,
  metricVec3,
  placement,
} from '../src/index.js';
import { island } from './fixture.js';

/**
 * The local-versus-presentation separation (interaction-model.md 1.2, risk R-48).
 *
 * Half of these assertions are `@ts-expect-error` directives rather than runtime checks. That is
 * on purpose: the document says enforcement is "in the type system, not in code review", so the
 * test for it has to be a compile error. `pnpm run typecheck` includes this directory, and an
 * unused `@ts-expect-error` is itself a TypeScript error, so if any of these confusions ever
 * stops being rejected the build fails.
 */
describe('coordinate frames are not interchangeable', () => {
  it('rejects a LocalVec3 where an AtlasVec3 is expected', () => {
    // @ts-expect-error a local position is not an atlas position
    placement(localVec3(1, 2, 3), 0, 1);
    expect(true).toBe(true);
  });

  it('rejects an AtlasVec3 where a LocalVec3 is expected', () => {
    // @ts-expect-error an atlas position is not a local position
    localDistance(atlasVec3(0, 0, 0), localVec3(1, 0, 0));
    expect(true).toBe(true);
  });

  it('rejects measuring metric distance between non-metric local positions', () => {
    // @ts-expect-error metric distance requires proof that the frame is metric
    metricDistance(localVec3(0, 0, 0), localVec3(1, 0, 0));
    expect(true).toBe(true);
  });

  it('rejects measuring distance between atlas positions', () => {
    // @ts-expect-error atlas positions are a layout artifact and carry no distance
    localDistance(atlasVec3(0, 0, 0), atlasVec3(10, 0, 0));
    expect(true).toBe(true);
  });

  it('does not export a way back from atlas space, or a distance over it', () => {
    // The one-way conversion is a runtime-observable property of the public surface, so it gets
    // a runtime assertion as well as the compile-time ones above.
    const exported = Object.keys(atlasCore);
    expect(exported).toContain('localToAtlas');
    expect(exported).not.toContain('atlasToLocal');
    expect(exported.filter((k) => /^atlas.*[Dd]istance/.test(k))).toEqual([]);
    expect(exported.filter((k) => /[Dd]istance/.test(k)).sort()).toEqual([
      'localDistance',
      'metricDistance',
    ]);
  });
});

describe('localToAtlas is the one legal conversion', () => {
  it('applies scale, then yaw about the shared up axis, then translation', () => {
    const p = placement(atlasVec3(10, 0, -4), Math.PI / 2, 2);
    const a = localToAtlas(p, localVec3(1, 3, 0));
    // Scale 2 gives (2, 6, 0). Yaw +90 degrees maps local +X onto atlas -Z.
    expect(a.x).toBeCloseTo(10, 10);
    expect(a.y).toBeCloseTo(6, 10);
    expect(a.z).toBeCloseTo(-6, 10);
  });

  it('never pitches or rolls, so the up axis stays globally shared', () => {
    const p = placement(atlasVec3(3, 0, 7), 1.234, 1.7);
    const up = localToAtlas(p, localVec3(0, 1, 0));
    const origin = localToAtlas(p, localVec3(0, 0, 0));
    expect(up.x - origin.x).toBeCloseTo(0, 12);
    expect(up.z - origin.z).toBeCloseTo(0, 12);
    expect(up.y - origin.y).toBeCloseTo(1.7, 12);
  });

  it('maps the same local point to different atlas points under different placements', () => {
    // The whole point of the separation: an anchor's local position is a fact about the capture,
    // and its atlas position is a fact about the layout. They are not the same number.
    const local = localVec3(2, 1, -5);
    const a = localToAtlas(placement(atlasVec3(0, 0, 0), 0, 1), local);
    const b = localToAtlas(placement(atlasVec3(300, 0, -120), 2.1, 1), local);
    expect(a).not.toEqual(b);
  });
});

describe('metric positions require a metric island', () => {
  const anchors = [{ key: 'a', local: [0, 1, -2] as const }];

  it('yields a MetricVec3 when the reconstruction recovered scale', () => {
    const metric = island({ key: 'i', createdAt: 0, anchors, metric: true });
    const p = asMetricLocal(metric, localVec3(0, 0, 0));
    const q = asMetricLocal(metric, localVec3(3, 4, 0));
    expect(p).not.toBeNull();
    expect(q).not.toBeNull();
    expect(metricDistance(p!, q!)).toBeCloseTo(5, 12);
  });

  it('refuses rather than estimating when the island is not metric', () => {
    const loose = island({ key: 'j', createdAt: 0, anchors, metric: false });
    expect(asMetricLocal(loose, localVec3(0, 0, 0))).toBeNull();
  });

  it('accepts a MetricVec3 wherever a LocalVec3 is wanted, but not the reverse', () => {
    expect(localDistance(atlasCore.metricAsLocal(metricVec3(0, 0, 0)), localVec3(1, 0, 0))).toBe(1);
    // @ts-expect-error widening is free, narrowing needs proof
    const bad: ReturnType<typeof metricVec3> = localVec3(0, 0, 0);
    expect(bad).toBeDefined();
  });
});

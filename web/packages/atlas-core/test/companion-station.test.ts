import { describe, expect, it } from 'vitest';
import type { AtlasVec3, ScreenRect, StationInputs } from '../src/index.js';
import {
  DEFAULT_PLACEMENT_CONFIG,
  atlasVec3,
  homePosition,
  resolveStation,
} from '../src/index.js';

/**
 * The point of these tests is that every fallback to home is REASONED. A station that quietly
 * went home would look identical on screen to one that chose to, and the caller would have no
 * honest caption to render for the difference.
 */

const PANEL_LEFT: ScreenRect = { minX: -1, minY: -1, maxX: -0.2, maxY: -0.1 };
const PANEL_RIGHT: ScreenRect = { minX: 0.2, minY: -1, maxX: 1, maxY: -0.1 };

const EYE = atlasVec3(0, 1.7, 0);
const AHEAD = atlasVec3(0, 0, -1);

function inputs(over: Partial<StationInputs> = {}): StationInputs {
  return {
    camera: { position: EYE, forward: AHEAD },
    subject: atlasVec3(0, 1.7, -8),
    panel: PANEL_LEFT,
    visible: () => true,
    obstacles: [],
    previous: null,
    reducedMotion: false,
    ...over,
  };
}

/** Independent NDC x, so a sign error in the station code cannot cancel itself out here. */
function ndcX(p: AtlasVec3, camPos: AtlasVec3, fwd: AtlasVec3): number {
  const d = { x: p.x - camPos.x, y: p.y - camPos.y, z: p.z - camPos.z };
  const r = { x: fwd.y * 0 - fwd.z * 1, y: 0, z: fwd.x * 1 - fwd.y * 0 };
  const rl = Math.hypot(r.x, r.y, r.z) || 1;
  const right = { x: r.x / rl, y: r.y / rl, z: r.z / rl };
  const depth = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
  return (
    (d.x * right.x + d.y * right.y + d.z * right.z) /
    (depth * Math.tan(DEFAULT_PLACEMENT_CONFIG.hFovRad / 2))
  );
}

describe('home is a place you never have to hunt for', () => {
  it('sits off the shoulder opposite the panel', () => {
    const home = homePosition({ position: EYE, forward: AHEAD });
    expect(ndcX(home, EYE, AHEAD)).toBeGreaterThan(0);
  });

  it('stays within a pace or two, near enough to read as accompanying', () => {
    const home = homePosition({ position: EYE, forward: AHEAD });
    const d = Math.hypot(home.x - EYE.x, home.y - EYE.y, home.z - EYE.z);
    // Far enough not to loom, near enough that it is plainly with you rather than out in the
    // world on its own. Both bounds have been wrong once and both are load bearing.
    expect(d).toBeGreaterThan(2.5);
    expect(d).toBeLessThan(6);
  });

  it('travels with the camera rather than staying put in the world', () => {
    const a = homePosition({ position: EYE, forward: AHEAD });
    const b = homePosition({ position: atlasVec3(40, 1.7, 40), forward: AHEAD });
    expect(b.x - a.x).toBeCloseTo(40, 6);
    expect(b.z - a.z).toBeCloseTo(40, 6);
  });

  it('sits below the eye line', () => {
    const home = homePosition({ position: EYE, forward: AHEAD });
    expect(home.y).toBeLessThan(EYE.y);
  });
});

describe('it leaves home only when leaving is honest', () => {
  it('goes to the anchor when the anchor is in view', () => {
    const s = resolveStation(inputs());
    expect(s.kind).toBe('errand');
    expect(s.homeReason).toBeNull();
    expect(s.placement).not.toBeNull();
  });

  it('stays home when there is nothing to point at', () => {
    const s = resolveStation(inputs({ subject: null }));
    expect(s.kind).toBe('home');
    expect(s.homeReason).toBe('no-subject');
  });

  it('stays home rather than sending the user hunting behind them', () => {
    const s = resolveStation(inputs({ subject: atlasVec3(0, 1.7, 8) }));
    expect(s.kind).toBe('home');
    expect(s.homeReason).toBe('subject-off-screen');
  });

  it('stays home under reduced motion', () => {
    const s = resolveStation(inputs({ reducedMotion: true }));
    expect(s.kind).toBe('home');
    // The caption the caller must render replaces the pointing the movement would have done.
    expect(s.homeReason).toBe('reduced-motion');
  });

  it('stays home when the solver found nowhere legal to stand', () => {
    const s = resolveStation(inputs({ visible: () => false }));
    expect(s.kind).toBe('home');
    expect(s.homeReason).toBe('no-placement');
  });

  it('stays home rather than sweeping across the view', () => {
    // Panel on the right pushes the arc solver to the left, while home is off the right
    // shoulder. The errand would therefore cross the middle of the view, which 4.2 forbids.
    const s = resolveStation(inputs({ panel: PANEL_RIGHT }));
    expect(s.kind).toBe('home');
    expect(s.homeReason).toBe('sweep-too-wide');
  });

  it('always explains itself when it could have travelled and did not', () => {
    for (const over of [
      { subject: null },
      { subject: atlasVec3(0, 1.7, 8) },
      { reducedMotion: true },
      { visible: () => false },
      { panel: PANEL_RIGHT },
    ] as Partial<StationInputs>[]) {
      const s = resolveStation(inputs(over));
      expect(s.kind).toBe('home');
      expect(s.homeReason).not.toBeNull();
    }
  });
});

describe('attention is expressed by orientation', () => {
  it('turns to face the subject even while staying home', () => {
    const subject = atlasVec3(9, 1.7, -4);
    // Off screen, so it cannot travel. It must still look at what it is asking about.
    const s = resolveStation(inputs({ subject, camera: { position: EYE, forward: AHEAD } }));
    const facing = { x: -Math.sin(s.yaw), z: -Math.cos(s.yaw) };
    const to = { x: subject.x - s.position.x, z: subject.z - s.position.z };
    const len = Math.hypot(to.x, to.z);
    expect(facing.x * (to.x / len) + facing.z * (to.z / len)).toBeCloseTo(1, 6);
  });
});

describe('it never glides across the user view', () => {
  it('dissolves and reassembles when the move would sweep the view', () => {
    const previous = resolveStation(inputs());
    // A near-identical distance, but on the far side of the view.
    const acrossView = {
      ...previous,
      position: atlasVec3(-previous.position.x - 2, previous.position.y, previous.position.z),
    };
    const s = resolveStation(inputs({ previous: acrossView }));
    expect(s.materialization).toBe('reassemble');
  });

  it('assembles from nothing on first appearance', () => {
    expect(resolveStation(inputs()).materialization).toBe('assemble');
  });

  it('glides for a small move that stays on one side', () => {
    const first = resolveStation(inputs());
    const nudged = {
      ...first,
      position: atlasVec3(first.position.x + 0.3, first.position.y, first.position.z + 0.3),
    };
    expect(resolveStation(inputs({ previous: nudged })).materialization).toBe('glide');
  });
});

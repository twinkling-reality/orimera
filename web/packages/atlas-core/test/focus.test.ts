import { describe, expect, it } from 'vitest';
import type { CameraPose, FocusInputs, FocusState } from '../src/index.js';
import {
  DEFAULT_FOCUS_CONFIG,
  INITIAL_FOCUS_STATE,
  anchorId,
  atlasVec3,
  buildAnchorTable,
  focusDirectly,
  forwardFromYawPitch,
  islandId,
  latchFocus,
  neutralEmphasis,
  occurrenceNormalizer,
  releaseFocus,
  resolveFocus,
  tabOrder,
} from '../src/index.js';
import { island, scene } from './fixture.js';

/**
 * Focus is RETICLE-BASED. Every test here aims the camera, never a cursor, because Pointer Lock
 * freezes clientX and clientY while locked (https://w3c.github.io/pointerlock/) and there is no
 * cursor position to test with.
 */

// An island at the atlas origin with no yaw, so local coordinates read directly as atlas ones
// and the test's intent stays legible. That equality is a property of THIS fixture, not of the
// type system; coords.test.ts is what asserts the two frames are otherwise distinct.
const world = scene([
  island({
    key: 'i1',
    createdAt: 1,
    position: [0, 0, 0],
    anchors: [
      { key: 'straight-ahead', local: [0, 1.6, -6], radius: 0.4 },
      { key: 'off-axis', local: [2.4, 1.6, -6], radius: 0.4 },
      { key: 'near-large', local: [0.55, 1.6, -2.5], radius: 0.9 },
      { key: 'far-small', local: [1.6, 1.6, -18], radius: 0.15 },
    ],
  }),
]);

const table = buildAnchorTable(world);
const emphasis = neutralEmphasis(table);
const normalizer = occurrenceNormalizer(table.anchors);

function look(yaw: number, pitch = 0, from: readonly [number, number, number] = [0, 1.6, 0]): CameraPose {
  return { position: atlasVec3(from[0], from[1], from[2]), forward: forwardFromYawPitch(yaw, pitch) };
}

function inputs(camera: CameraPose, nowMs: number, extra: Partial<FocusInputs> = {}): FocusInputs {
  return { table, emphasis, camera, nowMs, occurrenceNormalizer: normalizer, ...extra };
}

/** Hold the camera still and step time forward until the solver settles. */
function settle(camera: CameraPose, ms = 400, start: FocusState = INITIAL_FOCUS_STATE): FocusState {
  let state = start;
  for (let t = 0; t <= ms; t += 16) state = resolveFocus(inputs(camera, t), state).state;
  return state;
}

const nameAt = (state: FocusState): string | null =>
  state.focusedIndex === null ? null : table.anchorIds[state.focusedIndex]!;

describe('the reticle picks the target', () => {
  it('focuses what the camera centre is on', () => {
    // Looking down -Z, which is where the fixture puts `straight-ahead`.
    expect(nameAt(settle(look(Math.PI)))).toBe('i1/straight-ahead');
  });

  it('focuses nothing when the reticle is on empty space', () => {
    expect(nameAt(settle(look(0)))).toBeNull();
  });

  it('returns at most one target, because attention is single-valued', () => {
    const r = resolveFocus(inputs(look(Math.PI), 1000), settle(look(Math.PI)));
    expect(r.focused).not.toBeNull();
    expect(Array.isArray(r.focused)).toBe(false);
  });

  it('never focuses an anchor the manifest made non-interactable', () => {
    const hiddenAll = { ...emphasis, anchorInteractable: new Uint8Array(table.count) };
    let state = INITIAL_FOCUS_STATE;
    for (let t = 0; t <= 400; t += 16) {
      state = resolveFocus(inputs(look(Math.PI), t, { emphasis: hiddenAll }), state).state;
    }
    expect(state.focusedIndex).toBeNull();
  });
});

describe('the aim cone widens for close anchors', () => {
  // `near-large` is 2.5 m away with a 0.9 m radius, so it subtends about 20 degrees.
  // `far-small` is 18 m away with a 0.15 m radius, so it subtends about half a degree.
  const offAxisDeg = 12;

  it('lets a large nearby anchor be focused well off the base cone', () => {
    const yaw = Math.PI - (offAxisDeg * Math.PI) / 180;
    expect(DEFAULT_FOCUS_CONFIG.coneHalfAngle).toBeLessThan((offAxisDeg * Math.PI) / 180);
    expect(nameAt(settle(look(yaw)))).toBe('i1/near-large');
  });

  it('does not let a small distant anchor be focused off the base cone', () => {
    const smallOnly = scene([
      island({
        key: 'j',
        createdAt: 1,
        position: [0, 0, 0],
        anchors: [{ key: 'far-small', local: [0, 1.6, -18], radius: 0.15 }],
      }),
    ]);
    const t2 = buildAnchorTable(smallOnly);
    const e2 = neutralEmphasis(t2);
    let state = INITIAL_FOCUS_STATE;
    // 12 degrees off, against a base cone of 7 degrees widened by the half degree this
    // anchor subtends at 18 m. Outside. The same 12 degrees hits `near-large` in the test above,
    // which is the whole point: the cone is a function of what the anchor actually covers.
    const camera = look(Math.PI - (offAxisDeg * Math.PI) / 180);
    for (let t = 0; t <= 400; t += 16) {
      state = resolveFocus(
        { table: t2, emphasis: e2, camera, nowMs: t, occurrenceNormalizer: 1 },
        state,
      ).state;
    }
    expect(state.focusedIndex).toBeNull();
  });
});

describe('the dwell stops the label strobing', () => {
  const camera = look(Math.PI);

  it('does not focus before the dwell has elapsed', () => {
    let state = resolveFocus(inputs(camera, 0), INITIAL_FOCUS_STATE).state;
    expect(state.focusedIndex).toBeNull();
    state = resolveFocus(inputs(camera, DEFAULT_FOCUS_CONFIG.dwellMs - 1), state).state;
    expect(state.focusedIndex).toBeNull();
  });

  it('focuses once the dwell has elapsed', () => {
    let state = resolveFocus(inputs(camera, 0), INITIAL_FOCUS_STATE).state;
    state = resolveFocus(inputs(camera, DEFAULT_FOCUS_CONFIG.dwellMs), state).state;
    expect(nameAt(state)).toBe('i1/straight-ahead');
  });

  it('restarts the dwell when the winner changes', () => {
    let state = resolveFocus(inputs(look(0), 0), INITIAL_FOCUS_STATE).state;
    state = resolveFocus(inputs(camera, 50), state).state;
    state = resolveFocus(inputs(camera, 100), state).state;
    expect(state.focusedIndex).toBeNull();
    state = resolveFocus(inputs(camera, 141), state).state;
    expect(nameAt(state)).toBe('i1/straight-ahead');
  });
});

describe('an incumbent keeps focus unless beaten by a margin', () => {
  it('holds the incumbent against a marginally better challenger', () => {
    const held = settle(look(Math.PI));
    expect(nameAt(held)).toBe('i1/straight-ahead');
    // Nudge the camera one degree toward `off-axis`. The two are close in score, so the margin
    // should hold the incumbent rather than swapping the label.
    let state = held;
    const nudged = look(Math.PI - (1 * Math.PI) / 180);
    for (let t = 500; t <= 900; t += 16) state = resolveFocus(inputs(nudged, t), state).state;
    expect(nameAt(state)).toBe('i1/straight-ahead');
  });

  it('yields to a decisively better challenger', () => {
    let state = settle(look(Math.PI));
    const swung = look(Math.PI - (21.8 * Math.PI) / 180);
    for (let t = 500; t <= 1200; t += 16) state = resolveFocus(inputs(swung, t), state).state;
    expect(nameAt(state)).toBe('i1/off-axis');
  });
});

describe('occlusion runs against a proxy, at a reduced rate, never the point cloud', () => {
  it('excludes an anchor the visibility test rejects', () => {
    let state = INITIAL_FOCUS_STATE;
    const camera = look(Math.PI);
    const blockStraightAhead = () => false;
    for (let t = 0; t <= 400; t += 16) {
      state = resolveFocus(inputs(camera, t, { visible: blockStraightAhead }), state).state;
    }
    expect(state.focusedIndex).toBeNull();
  });

  it('does not re-test more often than the configured interval', () => {
    let calls = 0;
    const visible = () => {
      calls += 1;
      return true;
    };
    let state = INITIAL_FOCUS_STATE;
    const camera = look(Math.PI);
    // 300 ms of 16 ms frames at a 100 ms interval is at most 4 refreshes, each testing at most
    // `occlusionCandidates` anchors.
    for (let t = 0; t <= 300; t += 16) {
      state = resolveFocus(inputs(camera, t, { visible }), state).state;
    }
    expect(calls).toBeLessThanOrEqual(4 * DEFAULT_FOCUS_CONFIG.occlusionCandidates);
  });
});

describe('Interact latches focus, and Tab is the keyboard route', () => {
  it('holds the latched anchor even when the camera swings away', () => {
    const latched = latchFocus(settle(look(Math.PI)));
    const r = resolveFocus(inputs(look(0), 2000), latched);
    expect(r.focused?.anchorId).toBe(anchorId('i1/straight-ahead'));
    const released = releaseFocus(r.state);
    expect(released.latched).toBe(false);
  });

  it('cycles anchors in the current island by distance, not by aim', () => {
    const order = tabOrder(table, emphasis, look(0), islandId('i1'));
    // 2.56 m, 6.00 m, 6.46 m, 18.07 m from the camera.
    expect(order.map((i) => table.anchorIds[i])).toEqual([
      'i1/near-large',
      'i1/straight-ahead',
      'i1/off-axis',
      'i1/far-small',
    ]);
  });

  it('focuses directly, bypassing the dwell, exactly as Locate does', () => {
    const i = table.indexOf.get(anchorId('i1/far-small'))!;
    const state = focusDirectly(INITIAL_FOCUS_STATE, i, 0);
    expect(nameAt(state)).toBe('i1/far-small');
  });
});

describe('importance is derived from the query, so recomposition aids aim', () => {
  it('prefers an unresolved anchor over a resolved one when aim and distance tie', () => {
    const tied = scene([
      island({
        key: 'k',
        createdAt: 1,
        position: [0, 0, 0],
        anchors: [
          { key: 'settled', local: [-0.35, 1.6, -6], resolved: true, occurrences: 1 },
          { key: 'open-question', local: [0.35, 1.6, -6], resolved: false, occurrences: 20 },
        ],
      }),
    ]);
    const t2 = buildAnchorTable(tied);
    const e2 = neutralEmphasis(t2);
    let state = INITIAL_FOCUS_STATE;
    const camera = look(Math.PI);
    for (let t = 0; t <= 400; t += 16) {
      state = resolveFocus(
        { table: t2, emphasis: e2, camera, nowMs: t, occurrenceNormalizer: occurrenceNormalizer(t2.anchors) },
        state,
      ).state;
    }
    expect(t2.anchorIds[state.focusedIndex!]).toBe('k/open-question');
  });
});

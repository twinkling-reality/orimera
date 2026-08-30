import { describe, expect, it } from 'vitest';
import {
  MOTE_COUNT,
  MOTE_NEIGHBOR_EDGES,
  MOTE_PROFILES,
  MOTE_STATE_CAPTIONS,
  MOTE_STATES,
  moteRestPoint,
  sampleMote,
  sampleThreadAlpha,
  threadLimit,
  type MoteState,
} from '../src/ui/companion-motes.js';

const radius = (point: readonly [number, number, number]): number => Math.hypot(...point);
const direction = (point: readonly [number, number, number]): readonly [number, number, number] => {
  const r = radius(point);
  return [point[0] / r, point[1] / r, point[2] / r];
};
const dot = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('the Companion keeps one body', () => {
  it('keeps every mote on its permanent spherical layer in every state', () => {
    for (const state of MOTE_STATES) {
      for (const elapsed of [0, 3.25, 19.5]) {
        for (let index = 0; index < MOTE_COUNT; index += 1) {
          expect(radius(sampleMote(state, index, elapsed).position)).toBeCloseTo(
            radius(moteRestPoint(index)),
            10,
          );
        }
      }
    }
  });

  it('changes internal positions without changing their distance from the centre', () => {
    const moved = Array.from({ length: MOTE_COUNT }, (_, index) => {
      const atRest = moteRestPoint(index);
      const working = sampleMote('working', index, 6.5).position;
      return Math.hypot(
        working[0] - atRest[0],
        working[1] - atRest[1],
        working[2] - atRest[2],
      );
    }).filter((distance) => distance > 1e-5);
    expect(moved.length).toBeGreaterThan(MOTE_COUNT * 0.8);
  });
});

describe('epistemic state drives every confidence cue', () => {
  it('never lets an unconfirmed link look more certain than a confirmed one', () => {
    const uncertain = MOTE_PROFILES.uncertain;
    const settled = MOTE_PROFILES.settled;
    for (const cue of [
      'certainty',
      'brightness',
      'coherence',
      'connectionDensity',
      'steadiness',
    ] as const) {
      expect(uncertain[cue], cue).toBeLessThan(settled[cue]);
    }
    expect(threadLimit('uncertain')).toBeLessThan(threadLimit('settled'));
  });

  it('only forms threads between nearby motes', () => {
    const unique = new Set<string>();
    for (const [from, to] of MOTE_NEIGHBOR_EDGES) {
      expect(from).toBeLessThan(to);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThan(MOTE_COUNT);
      expect(unique.has(`${from}:${to}`)).toBe(false);
      unique.add(`${from}:${to}`);
      expect(dot(direction(moteRestPoint(from)), direction(moteRestPoint(to)))).toBeGreaterThan(
        0.96,
      );
    }
  });
});

describe('reduced motion is a complete alternative', () => {
  it('is static at every elapsed time', () => {
    for (const state of MOTE_STATES) {
      for (let index = 0; index < MOTE_COUNT; index += 37) {
        expect(sampleMote(state, index, 40, true)).toEqual(sampleMote(state, index, 0, true));
      }
      for (let edge = 0; edge < threadLimit(state); edge += 7) {
        expect(sampleThreadAlpha(state, edge, 40, true)).toBe(
          sampleThreadAlpha(state, edge, 0, true),
        );
      }
    }
  });

  it('has a mandatory plain-language caption for every state', () => {
    for (const state of MOTE_STATES) {
      expect(MOTE_STATE_CAPTIONS[state].trim().length, state).toBeGreaterThan(20);
    }
    expect(MOTE_STATE_CAPTIONS.uncertain.toLowerCase()).toContain('unconfirmed');
    expect(MOTE_STATE_CAPTIONS.settled.toLowerCase()).toContain('confirmed');
  });
});

// Compile-time exhaustiveness for the state table used by the renderer and the caption channel.
const _allStates: Readonly<Record<MoteState, unknown>> = MOTE_PROFILES;
void _allStates;

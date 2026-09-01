import { describe, expect, it } from 'vitest';
import { MAP_PEEK_HOLD_MS, MapPeek } from '../src/ui/map-peek.js';

function harness(mapActive = false) {
  const calls: string[] = [];
  let pending: (() => void) | null = null;
  let active = mapActive;
  const peek = new MapPeek({
    isMapActive: () => active,
    enterMap: () => { active = true; calls.push('enter'); },
    leaveMap: () => { active = false; calls.push('leave'); },
    toggleMap: () => { active = !active; calls.push('toggle'); },
    schedule: (run, ms) => { expect(ms).toBe(MAP_PEEK_HOLD_MS); pending = run; return 1; },
    cancel: () => { pending = null; },
  });
  return {
    peek,
    calls,
    /** Let the hold threshold elapse. */
    hold: () => { const run = pending; pending = null; run?.(); },
    isMapActive: () => active,
    isArmed: () => pending !== null,
  };
}

describe('map peek', () => {
  it('travels to the Map on a tap', () => {
    const h = harness();
    h.peek.press();
    h.peek.release();
    expect(h.calls).toEqual(['toggle']);
  });

  it('lifts on a hold and drops back on release', () => {
    const h = harness();
    h.peek.press();
    h.hold();
    expect(h.calls).toEqual(['enter']);
    expect(h.isMapActive()).toBe(true);
    h.peek.release();
    expect(h.calls).toEqual(['enter', 'leave']);
    expect(h.isMapActive()).toBe(false);
  });

  it('never travels as well as looking', () => {
    const h = harness();
    h.peek.press();
    h.hold();
    h.peek.release();
    expect(h.calls).not.toContain('toggle');
  });

  it('arms the hold exactly once however many repeats arrive', () => {
    const h = harness();
    h.peek.press();
    h.peek.press();
    h.peek.press();
    h.hold();
    expect(h.calls).toEqual(['enter']);
  });

  it('stays a plain tap when the Map is already the active camera', () => {
    const h = harness(true);
    h.peek.press();
    expect(h.isArmed()).toBe(false);
    h.peek.release();
    expect(h.calls).toEqual(['toggle']);
  });

  /* A keyup that never arrives must not stand someone in a Map they did not ask to travel to. */
  it('drops back when the window takes the keyup away mid-hold', () => {
    const h = harness();
    h.peek.press();
    h.hold();
    h.peek.abort();
    expect(h.calls).toEqual(['enter', 'leave']);
    expect(h.isMapActive()).toBe(false);
  });

  it('does nothing on a lost focus that interrupts a press before the threshold', () => {
    const h = harness();
    h.peek.press();
    h.peek.abort();
    expect(h.calls).toEqual([]);
    h.hold();
    expect(h.calls).toEqual([]);
  });

  it('ignores a release nobody pressed for', () => {
    const h = harness();
    h.peek.release();
    expect(h.calls).toEqual([]);
  });
});

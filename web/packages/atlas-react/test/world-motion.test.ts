import { describe, expect, it } from 'vitest';
import { worldMotionSeconds } from '../src/playcanvas/world-field.js';

describe('world ambient motion', () => {
  it('lets a bounded style tempo change cadence', () => {
    expect(worldMotionSeconds(5_200, 5_200, false)).toBe(5.2);
    expect(worldMotionSeconds(5_200, 4_160, false)).toBe(6.5);
  });

  it('lets reduced motion override every style tempo', () => {
    expect(worldMotionSeconds(42_000, 4_160, true)).toBe(0);
    expect(worldMotionSeconds(42_000, 6_934, true)).toBe(0);
  });
});

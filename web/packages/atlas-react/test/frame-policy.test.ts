import { describe, expect, it } from 'vitest';
import {
  IDLE_FRAME_MS,
  SETTLED_FRAME_MS,
  shouldDrawFrame,
  type FramePolicyInput,
} from '../src/playcanvas/frame-policy.js';

const settled: FramePolicyInput = {
  dirty: false,
  navigating: false,
  poseChanged: false,
  reducedMotion: false,
  sinceLastRenderMs: 0,
};

describe('frame policy', () => {
  it('draws whenever the camera has moved', () => {
    expect(shouldDrawFrame({ ...settled, poseChanged: true })).toBe(true);
  });

  it('draws while direct travel owns the camera', () => {
    expect(shouldDrawFrame({ ...settled, navigating: true })).toBe(true);
  });

  it('draws for a change no pose reports, such as a profile or Map swap', () => {
    expect(shouldDrawFrame({ ...settled, dirty: true })).toBe(true);
  });

  it('skips an identical frame on a still camera', () => {
    expect(shouldDrawFrame(settled)).toBe(false);
  });

  it('keeps ambient motion running at the idle cadence', () => {
    expect(shouldDrawFrame({ ...settled, sinceLastRenderMs: IDLE_FRAME_MS - 1 })).toBe(false);
    expect(shouldDrawFrame({ ...settled, sinceLastRenderMs: IDLE_FRAME_MS })).toBe(true);
  });

  /*
   * The freeze this file exists to prevent. A photograph that finishes decoding while nobody is
   * moving has nothing to announce it, so a settled world that stopped dead would never show it.
   */
  it('still ticks over when reduced motion has stilled the world', () => {
    const held = { ...settled, reducedMotion: true, sinceLastRenderMs: IDLE_FRAME_MS };
    expect(shouldDrawFrame(held)).toBe(false);
    expect(shouldDrawFrame({ ...held, sinceLastRenderMs: SETTLED_FRAME_MS })).toBe(true);
  });

  it('draws before anything has ever been drawn', () => {
    expect(shouldDrawFrame({ ...settled, sinceLastRenderMs: -1 })).toBe(true);
    expect(shouldDrawFrame({ ...settled, sinceLastRenderMs: Number.NaN })).toBe(true);
  });
});

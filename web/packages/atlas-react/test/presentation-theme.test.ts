import { describe, expect, it } from 'vitest';
import { BLUE_HOUR_THEME, DAWN_THEME } from '@orimera/presentation';
import { anchorMoteRgba } from '../src/playcanvas/anchor-motes.js';
import { mapCameraState } from '../src/playcanvas/atlas-binding.js';

describe('renderer presentation theme', () => {
  it('changes mote RGB with the shared palette while retaining confirmation dimming', () => {
    const settled = anchorMoteRgba(BLUE_HOUR_THEME, 'user', false);
    const proposed = anchorMoteRgba(BLUE_HOUR_THEME, 'user', true);
    const dawn = anchorMoteRgba(DAWN_THEME, 'user', false);
    expect(settled.slice(0, 3)).not.toEqual(dawn.slice(0, 3));
    expect(proposed.slice(0, 3)).toEqual(settled.slice(0, 3));
    expect(proposed[3]).toBeLessThan(settled[3]);
  });

  it('derives a stable empty-world map pose without fabricating an island', () => {
    const pose = mapCameraState({ islands: [], layoutVersion: 1, stateVersion: 1 });
    expect(pose).toMatchObject({ x: 0, y: 28, yaw: 0 });
    expect(pose.pitch).toBeCloseTo(-(55 * Math.PI) / 180);
    expect(pose.z).toBeCloseTo(28 / Math.tan((55 * Math.PI) / 180));
  });
});

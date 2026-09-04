// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import {
  atlasVec3,
  islandId,
  localVec3,
  makeIsland,
  makeScene,
  placement,
} from '@exulanica/atlas-core';
import { MapRegionOverlay } from '../src/playcanvas/map-region-overlay.js';

const scene = makeScene([
  makeIsland({
    islandId: islandId('later'),
    creationOrdinal: 8,
    createdAt: 2,
    placement: placement(atlasVec3(10, 0, 0), 0, 1),
    rung: 4,
    scaleIsMetric: false,
    footprintRadiusLocal: 4,
    viewpointLocal: localVec3(0, 1.6, 0),
    anchors: [],
    layoutEntities: new Set(),
  }),
  makeIsland({
    islandId: islandId('first'),
    creationOrdinal: 3,
    createdAt: 1,
    placement: placement(atlasVec3(0, 0, 0), 0, 1),
    rung: 4,
    scaleIsMetric: false,
    footprintRadiusLocal: 4,
    viewpointLocal: localVec3(0, 1.6, 0),
    anchors: [],
    layoutEntities: new Set(),
  }),
], 1, 1);

describe('Map region targets', () => {
  it('uses stable creation order and sends the exact island id', () => {
    const overlay = new MapRegionOverlay(document.body, scene);
    const selected = vi.fn();
    overlay.onSelect = selected;
    const buttons = Array.from(overlay.root.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Region 01', 'Region 02']);
    buttons[0]!.click();
    expect(selected).toHaveBeenCalledWith(islandId('first'));
    overlay.destroy();
  });

  it('exists only while Map is active', () => {
    const overlay = new MapRegionOverlay(document.body, scene);
    expect(overlay.root.hidden).toBe(true);
    overlay.setActive(true);
    expect(overlay.root.hidden).toBe(false);
    overlay.setActive(false);
    expect(overlay.root.hidden).toBe(true);
    overlay.destroy();
  });
});

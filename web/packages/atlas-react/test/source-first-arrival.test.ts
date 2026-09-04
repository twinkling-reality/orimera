import { describe, expect, it } from 'vitest';
import {
  atlasVec3,
  islandId,
  localVec3,
  makeIsland,
  placement,
} from '@exulanica/atlas-core';
import { sourceFirstArrivalPose } from '../src/playcanvas/atlas-binding.js';

describe('source-first arrival presentation', () => {
  it('changes only orientation and keeps the validated destination position exact', () => {
    const island = makeIsland({
      islandId: islandId('memory'),
      createdAt: 0,
      placement: placement(atlasVec3(12, 0, -4), 0.35, 1.2),
      rung: 4,
      scaleIsMetric: false,
      footprintRadiusLocal: 7,
      viewpointLocal: localVec3(0, 1.6, 0),
      anchors: [],
      layoutEntities: new Set(),
    });
    const position = atlasVec3(10, 1.62, 1);
    const arrival = { position, yaw: 0, pitch: 0 };
    const oriented = sourceFirstArrivalPose(island, arrival);
    expect(oriented.position).toBe(position);
    expect(oriented.yaw).not.toBe(arrival.yaw);
    expect(Number.isFinite(oriented.pitch)).toBe(true);
  });

  it('does not reinterpret a reconstructed destination', () => {
    const island = makeIsland({
      islandId: islandId('reconstructed'),
      createdAt: 0,
      placement: placement(atlasVec3(0, 0, 0), 0, 1),
      rung: 3,
      scaleIsMetric: false,
      footprintRadiusLocal: 7,
      viewpointLocal: localVec3(0, 1.6, 0),
      anchors: [],
      layoutEntities: new Set(),
    });
    const arrival = { position: atlasVec3(1, 1.62, 1), yaw: 0.4, pitch: -0.1 };
    expect(sourceFirstArrivalPose(island, arrival)).toBe(arrival);
  });
});

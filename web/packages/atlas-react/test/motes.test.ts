import { describe, expect, it } from 'vitest';
import type { Anchor, AnchorKind } from '@orimera/atlas-core';
import {
  anchorId,
  buildAnchorTable,
  islandId,
  localVec3,
  makeIsland,
  makeScene,
  occurrenceId,
  placement,
  atlasVec3,
} from '@orimera/atlas-core';

import {
  MOTE_FRAGMENT_GLSL,
  anchorKindSlot,
  moteAnchorIndices,
} from '../src/playcanvas/anchor-motes.js';

/**
 * The two rules the mote cloud carries, checked without a graphics device.
 *
 * Both are product rules rather than rendering preferences, which is why they are asserted here
 * and not left to whoever next adjusts how the Atlas looks.
 */

function anchor(id: string, kind: AnchorKind): Anchor {
  return {
    anchorId: anchorId(id),
    islandId: islandId('isl'),
    occurrenceId: occurrenceId(id),
    kind,
    local: localVec3(0, 0, 0),
    focusRadiusLocal: 0.5,
    entityId: null,
    linkState: 'proposed',
    provenance: 'inference',
    confidence: 'low',
    occurrenceCount: 0,
    resolved: false,
    evidence: [],
  };
}

function tableOf(anchors: readonly Anchor[]) {
  return buildAnchorTable(
    makeScene(
      [
        makeIsland({
          islandId: islandId('isl'),
          createdAt: 0,
          placement: placement(atlasVec3(0, 0, 0), 0, 1),
          rung: 4,
          scaleIsMetric: false,
          footprintRadiusLocal: 4,
          viewpointLocal: localVec3(0, 1.6, 0),
          anchors,
          layoutEntities: new Set(),
        }),
      ],
      1,
      1,
    ),
  );
}

describe('what gets a mote', () => {
  it('never gives a person one, because that would be a person in world geometry', () => {
    // People are citations, not reconstructions. A person anchor is a time-anchored presence
    // marker drawn by the overlay; a mote is world content, and the two are not interchangeable.
    const table = tableOf([anchor('a-person', 'person'), anchor('b-object', 'object')]);
    const kinds = [...moteAnchorIndices(table)].map((i) => table.anchors[i]!.kind);
    expect(kinds).toEqual(['object']);
  });

  it('gives one to every kind that is world content', () => {
    const table = tableOf([
      anchor('a-object', 'object'),
      anchor('b-place', 'place'),
      anchor('c-event', 'event'),
    ]);
    expect(moteAnchorIndices(table)).toHaveLength(3);
  });

  it('uses a different hard silhouette for every world-content kind', () => {
    expect([
      anchorKindSlot('place'),
      anchorKindSlot('object'),
      anchorKindSlot('event'),
    ]).toEqual([0, 1, 2]);
    expect(new Set(['place', 'object', 'event'].map((kind) =>
      anchorKindSlot(kind as AnchorKind),
    )).size).toBe(3);
  });

  it('draws a mote with a hard silhouette rather than a fade', () => {
    // In this binding a soft particulate edge MEANS "reconstructed surface": the point-map shader
    // uses it for the dissolve band where a capture stopped observing. A mote is a marker for a
    // detection and is not a surface, so it clips its own disc instead of fading out. Softening
    // this would make a marker read as recovered geometry, which is the one thing the rung
    // ladder exists to keep separate.
    expect(MOTE_FRAGMENT_GLSL).toContain('discard');
    expect(MOTE_FRAGMENT_GLSL).not.toContain('smoothstep(0.0');
  });
});

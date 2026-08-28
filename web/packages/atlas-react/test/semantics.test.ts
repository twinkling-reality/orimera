import { describe, expect, it } from 'vitest';
import type { OpmHeader } from '../src/playcanvas/opm.js';
import {
  MAX_SEGMENTS,
  PROVENANCE_SLOT,
  defaultSemanticsFor,
  isPresenceMarkerOnly,
  packSemantics,
  presenceMarkerSegmentIds,
} from '../src/playcanvas/semantics.js';

/**
 * The semantic table is the piece of the binding where a product rule turns into a number a
 * shader reads, so it is worth asserting the rules rather than the packing.
 */

const header = (segments: OpmHeader['segments']): OpmHeader =>
  ({
    format: 'orimera-point-map',
    version: 1,
    pointCount: 1,
    rung: 3,
    metric: true,
    viewpoint: { position: [0, 1.55, 0], forward: [0, 0, -1], fovYDeg: 55 },
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    colorAlpha: 'confidence',
    segments,
    sections: [],
  }) satisfies OpmHeader;

const SEGMENTS: OpmHeader['segments'] = [
  { id: 0, name: 'quay', cls: 'ground' },
  { id: 1, name: 'water', cls: 'water' },
  { id: 2, name: 'facade', cls: 'structure' },
  { id: 3, name: 'crate', cls: 'object' },
  { id: 4, name: 'person-near', cls: 'person' },
  { id: 5, name: 'planter', cls: 'vegetation' },
];

describe('per-point semantic state', () => {
  it('never treats a person as geometry', () => {
    const table = defaultSemanticsFor(header(SEGMENTS));
    const person = table.find((s) => s.cls === 'person');
    expect(person).toBeDefined();
    expect(isPresenceMarkerOnly(person!)).toBe(true);
    expect(presenceMarkerSegmentIds(table)).toEqual([4]);

    // The shader reads z as "discard this point". People render as time-anchored presence
    // markers in the overlay, which is a citation; baking one into the shell would be a
    // reconstruction of a person the capture never resolved.
    const packed = packSemantics(table);
    expect(packed[4 * 4 + 2]).toBe(1);
    for (const other of table.filter((s) => s.cls !== 'person')) {
      expect(packed[other.id * 4 + 2]).toBe(0);
    }
  });

  it('marks inferred, unconfirmed segments as unconfirmed and confirmed capture as not', () => {
    const packed = packSemantics(defaultSemanticsFor(header(SEGMENTS)));
    // facade: capture-supported and confirmed, so it reads as settled.
    expect(packed[2 * 4]).toBe(0);
    // water: a low-confidence proposal, so it must LOOK unconfirmed.
    expect(packed[1 * 4]).toBe(1);
    // vegetation: also a proposal, at medium confidence.
    expect(packed[5 * 4]).toBe(1);
  });

  it('keeps the four provenance classes visually distinct rather than collapsing them', () => {
    // Four classes, four slots. Merging any two here is how "capture-supported" and
    // "model-inferred" stop being distinguishable in the UI.
    const slots = new Set(Object.values(PROVENANCE_SLOT));
    expect(slots.size).toBe(4);
    expect(PROVENANCE_SLOT.capture).not.toBe(PROVENANCE_SLOT.inference);
    expect(PROVENANCE_SLOT.user).not.toBe(PROVENANCE_SLOT.external);
  });

  it('carries confidence as a per-segment floor the shader multiplies into per-point alpha', () => {
    const packed = packSemantics(defaultSemanticsFor(header(SEGMENTS)));
    const facadeFloor = packed[2 * 4 + 3]!;
    const waterFloor = packed[1 * 4 + 3]!;
    const planterFloor = packed[5 * 4 + 3]!;
    expect(facadeFloor).toBeGreaterThan(planterFloor);
    expect(planterFloor).toBeGreaterThan(waterFloor);
  });

  it('ignores segment ids outside the uniform table rather than writing past it', () => {
    const packed = packSemantics([
      {
        id: MAX_SEGMENTS + 3,
        name: 'overflow',
        cls: 'object',
        provenance: 'inference',
        linkState: 'proposed',
        confidence: 'low',
      },
    ]);
    expect(packed.length).toBe(MAX_SEGMENTS * 4);
    expect(packed.every((v) => v === 0)).toBe(true);
  });
});

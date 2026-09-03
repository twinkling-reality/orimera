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
    frame: 'local',
    up: '+Y',
    forward: '-Z',
    units: 'metres',
    metric: true,
    viewpoint: {
      position: [0, 1.55, 0],
      forward: [0, 0, -1],
      up: [0, 1, 0],
      fovYDeg: 55,
      aspect: 4 / 3,
    },
    sourceImage: { width: 400, height: 300 },
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

  it('marks proposed segments as unconfirmed and asserted surface as not', () => {
    const packed = packSemantics(defaultSemanticsFor(header(SEGMENTS)));
    // facade: surface with no identity claim attached, so there is nothing to be unconfirmed
    // about and the per-point dissolve stays off. How well sampled it is rides the alpha.
    expect(packed[2 * 4]).toBe(0);
    // water: a low-confidence proposal, so it must LOOK unconfirmed.
    expect(packed[1 * 4]).toBe(1);
    // vegetation: also a proposal, at medium confidence.
    expect(packed[5 * 4]).toBe(1);
  });

  it('never calls reconstructed geometry capture-supported', () => {
    // `ProvenanceClass`: capture is "a deterministic property of the recording"; inference is
    // "ANY model output, however confident". A depth network's opinion about where a wall is
    // fails the first and meets the second, whatever class the segment carries.
    const table = defaultSemanticsFor(header(SEGMENTS));
    expect(table.every((s) => s.provenance !== 'capture')).toBe(true);
    expect(table.find((s) => s.cls === 'structure')?.provenance).toBe('inference');
    expect(table.find((s) => s.cls === 'ground')?.provenance).toBe('inference');
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

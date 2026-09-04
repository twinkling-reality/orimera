import { describe, expect, it } from 'vitest';
import type { Anchor, AnchorId } from '@exulanica/atlas-core';
import { anchorId, evidenceRef, islandId, localVec3, occurrenceId } from '@exulanica/atlas-core';
import type { OpmHeader } from '../src/opm.js';
import {
  PROVENANCE_CODE,
  SEGMENT_FLAG,
  SegmentStateTable,
  bindSegmentsByName,
  unconfirmedWeight,
} from '../src/semantic-state.js';

const anchor = (key: string, over: Partial<Anchor>): Anchor =>
  Object.freeze({
    anchorId: anchorId(`harbour-1/${key}`),
    islandId: islandId('harbour-1'),
    occurrenceId: occurrenceId(`occ/${key}`),
    kind: 'object',
    local: localVec3(0, 0, 0),
    focusRadiusLocal: 1,
    entityId: null,
    linkState: 'proposed',
    provenance: 'inference',
    confidence: 'low',
    occurrenceCount: 1,
    resolved: false,
    evidence: [evidenceRef('span/x')],
    ...over,
  }) as Anchor;

const header = {
  segments: [
    { id: 0, name: 'quay', cls: 'ground' },
    { id: 4, name: 'crate', cls: 'object' },
    { id: 8, name: 'person-near', cls: 'person' },
    { id: 10, name: 'boat-hull', cls: 'object' },
  ],
} as unknown as OpmHeader;

describe('unconfirmedWeight', () => {
  it('is zero for anything the user said, whatever the link state', () => {
    expect(unconfirmedWeight(anchor('a', { provenance: 'user' }))).toBe(0);
  });

  it('is zero for a confirmed link', () => {
    expect(
      unconfirmedWeight(anchor('a', { linkState: 'confirmed', confidence: 'low' })),
    ).toBe(0);
  });

  it('orders proposed above auto_provisional at equal confidence', () => {
    // domain model id-2: auto_provisional may drive filtering and temporary highlighting; proposed
    // is a guess the system has not even provisionally acted on. That gap has to be visible.
    const provisional = unconfirmedWeight(
      anchor('a', { linkState: 'auto_provisional', confidence: 'high' }),
    );
    const proposed = unconfirmedWeight(anchor('a', { linkState: 'proposed', confidence: 'high' }));
    expect(proposed).toBeGreaterThan(provisional);
  });

  it('is maximal for a low-confidence proposal', () => {
    expect(unconfirmedWeight(anchor('a', { linkState: 'proposed', confidence: 'low' }))).toBe(1);
  });
});

describe('bindSegmentsByName', () => {
  it('binds by exact name and through the alias table, and never by substring', () => {
    const anchors = [anchor('crate-stack', {}), anchor('boat', {})];
    const bound = bindSegmentsByName(header, anchors, {
      crate: 'crate-stack',
      'boat-hull': 'boat',
    });
    expect(bound.map((b) => b.segment).sort((a, b) => a - b)).toEqual([4, 10]);

    // Without the aliases nothing matches, which is the point: a substring match between
    // "crate" and "crate-stack" would look right here and be wrong on a real scene.
    expect(bindSegmentsByName(header, anchors)).toEqual([]);
  });
});

describe('SegmentStateTable', () => {
  const anchors = [anchor('crate-stack', { linkState: 'proposed', confidence: 'medium' })];
  const indexOf = new Map<AnchorId, number>([[anchors[0]!.anchorId, 0]]);
  const emphasis = {
    anchorEmphasis: new Float32Array([1]),
    anchorLevel: new Uint8Array([0]),
    anchorInteractable: new Uint8Array([1]),
    anchorLabelable: new Uint8Array([1]),
    islandEmphasis: new Float32Array([1]),
    islandLevel: new Uint8Array([0]),
  };

  it('flags person segments so the point material can drop them', () => {
    const table = new SegmentStateTable(header, [], { indexOf, anchors });
    table.update(emphasis, 1, null);
    expect(table.data[8 * 4 + 3]! & SEGMENT_FLAG.person).toBe(SEGMENT_FLAG.person);
    expect(table.personSegmentIds.has(8)).toBe(true);
  });

  it('writes emphasis, unconfirmedness and provenance for a bound segment', () => {
    const table = new SegmentStateTable(header, [{ segment: 4, anchorId: anchors[0]!.anchorId }], {
      indexOf,
      anchors,
    });
    table.update(emphasis, 1, 0);
    expect(table.data[4 * 4]).toBe(255);
    expect(table.data[4 * 4 + 1]).toBeGreaterThan(0);
    expect(table.data[4 * 4 + 2]).toBe(PROVENANCE_CODE.inference);
    expect(table.data[4 * 4 + 3]! & SEGMENT_FLAG.focused).toBe(SEGMENT_FLAG.focused);
    expect(table.data[4 * 4 + 3]! & SEGMENT_FLAG.unresolved).toBe(SEGMENT_FLAG.unresolved);
  });

  it('reports no change on a repeat, so a still frame uploads nothing', () => {
    const table = new SegmentStateTable(header, [{ segment: 4, anchorId: anchors[0]!.anchorId }], {
      indexOf,
      anchors,
    });
    expect(table.update(emphasis, 1, null)).toBe(true);
    expect(table.update(emphasis, 1, null)).toBe(false);
    expect(table.update(emphasis, 1, 0)).toBe(true);
  });

  it('gives unbound capture surface the island emphasis, not an anchor state', () => {
    const table = new SegmentStateTable(header, [], { indexOf, anchors });
    table.update(emphasis, 0.5, null);
    expect(table.data[0]).toBe(128);
    expect(table.data[2]).toBe(PROVENANCE_CODE.capture);
    expect(table.data[3]! & SEGMENT_FLAG.bound).toBe(0);
  });
});

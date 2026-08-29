// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { BAND_ORDER } from '@orimera/companion-runtime';
import type { EntityRecord, GraphSnapshot, OccurrenceRecord } from '@orimera/graph-client';

import { EvidenceCache } from '../src/evidence.js';
import { buildDetail } from '../src/ui/detail.js';
import { buildLibrary } from '../src/ui/library.js';
import { STANDING_CAPTION, buildStatus } from '../src/ui/status.js';

/**
 * The rules a redesign of this surface must not quietly remove.
 *
 * Each one is specified somewhere and each one is the kind of thing that looks like an
 * improvement when you are making a screen calmer: hide the empty bands, drop the permanent
 * caption, warm up the placeholder text. They are asserted here because a review gate is a person
 * remembering, and the next person to work on this surface should find out from a red suite
 * rather than from a reviewer.
 *
 * A DOM environment is used deliberately. Every one of these is a fact about what renders, and
 * checking a view model instead would be checking a proxy for the thing under test. The docblock
 * above scopes happy-dom to this file: atlas-core and companion-runtime compile without lib.dom
 * on purpose, and a workspace-wide DOM would weaken that.
 */

const NO_EVIDENCE = new EvidenceCache({ evidenceBytes: () => Promise.reject(new Error('none')) });
const HANDLERS = { onName: () => undefined, onEvidenceOpened: () => undefined };

function entity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    entityId: 'e1',
    kind: 'object',
    displayName: null,
    status: 'inferred_only',
    occurrenceCount: 4,
    islandIds: ['isl'],
    firstSeenMs: null,
    lastSeenMs: null,
    confidence: 'low',
    openQuestionCount: 0,
    citingAnswerCount: 0,
    assertions: [],
    relations: [],
    contradictions: [],
    history: [],
    mergedInto: null,
    ...overrides,
  };
}

function occurrence(id: string, entityId: string | null = null): OccurrenceRecord {
  return {
    occurrenceId: id,
    anchorId: id,
    islandId: 'isl',
    kind: 'object',
    entityId,
    linkState: entityId === null ? 'proposed' : 'confirmed',
    confidence: 'low',
    evidence: [`span-${id}`],
    capturedAtMs: null,
  };
}

function snapshot(entities: readonly EntityRecord[], occurrences: readonly OccurrenceRecord[]): GraphSnapshot {
  return {
    stateVersion: 3,
    entities,
    occurrences,
    islands: [
      {
        islandId: 'isl',
        captureIds: ['c1'],
        firstCapturedAtMs: null,
        lastCapturedAtMs: null,
        positionedCaptureCount: 0,
        spreadMetres: null,
      },
    ],
    matchProposals: [],
    neverSame: [],
    deletedEntityIds: [],
  };
}

// ---------------------------------------------------------------------------------------------
// The four-band panel

describe('the provenance panel', () => {
  function panelOf(record: EntityRecord): HTMLElement {
    const detail = buildDetail(NO_EVIDENCE, HANDLERS);
    detail.showEntity(snapshot([record], [occurrence('o1', record.entityId)]), record);
    return detail.root.querySelector('.band-panel')!;
  }

  it('draws all four bands, in the fixed order, for an entity nobody has said anything about', () => {
    // Band 4 is never omitted, and the other three are not omitted either when they are empty.
    // What the system does not know is information, and a panel that showed only what it knew
    // would be the panel this one exists instead of.
    const bands = [...panelOf(entity()).querySelectorAll('.band')];
    expect(bands).toHaveLength(4);
    expect(bands.map((b) => b.className.match(/band-(\w+)/)?.[1])).toEqual([...BAND_ORDER]);
  });

  it('never leaves a band as a heading with nothing under it', () => {
    // A band draws either its rows or a sentence saying nothing is recorded. A heading with a
    // void beneath it reads as a rendering fault, which is the one reading that would make an
    // empty band say nothing at all rather than saying that nothing is known.
    for (const band of panelOf(entity()).querySelectorAll('.band')) {
      const rows = band.querySelectorAll('.band-row').length;
      const sentence = (band.querySelector('.band-empty')?.textContent ?? '').length;
      expect(rows + sentence, `${band.className} has a heading and nothing else`).toBeGreaterThan(
        0,
      );
    }
  });

  it('writes a sentence in a band that genuinely holds nothing', () => {
    // Band 1 over an entity nobody has spoken about is the case: the panel has to say that you
    // have not said anything, rather than showing a gap where your words would go.
    const told = panelOf(entity()).querySelector('.band-told')!;
    expect(told.querySelectorAll('.band-row')).toHaveLength(0);
    expect((told.querySelector('.band-empty')?.textContent ?? '').length).toBeGreaterThan(0);
  });

  it('never renders a raw message key where a sentence belongs', () => {
    // These packages emit keys and refuse to author prose. If the copy table has no entry, the
    // key renders, which is findable on purpose; it must not be findable in a shipped panel.
    const text = panelOf(entity()).textContent ?? '';
    expect(text).not.toMatch(/\b(row|unknown|method|external)\.[a-zA-Z]/);
  });
});

// ---------------------------------------------------------------------------------------------
// The standing caption

describe('the standing caption', () => {
  const status = () =>
    buildStatus({
      snapshot: snapshot([], []),
      regionCount: 1,
      rung: 4,
      omittedRegionCount: 0,
      undrawable: new Map(),
    });

  it('says exactly what interaction-model.md 6.2 fixes it to say', () => {
    expect(status().querySelector('.standing-caption')?.textContent).toBe(STANDING_CAPTION);
  });

  it('offers nothing that could dismiss it', () => {
    // Never dismissible. Not "dismissible but we chose not to add the button": the bar contains
    // no control at all, so there is nothing to wire a dismissal to.
    const bar = status();
    expect(bar.querySelectorAll('button, a, input, [role="button"]')).toHaveLength(0);
    expect(bar.querySelector('.standing-caption')?.hasAttribute('hidden')).toBe(false);
  });

  it('displays the rung the regions earned rather than hiding it', () => {
    const text = status().querySelector('.status-rung')?.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe('rung.4');
  });

  it('states what was left out instead of showing a smaller world as the whole one', () => {
    const bar = buildStatus({
      snapshot: snapshot([], []),
      regionCount: 5,
      rung: 4,
      omittedRegionCount: 3,
      undrawable: new Map([['voice', 7]]),
    });
    const warnings = [...bar.querySelectorAll('.status-warning')].map((n) => n.textContent ?? '');
    expect(warnings.some((w) => w.includes('3 regions are not shown'))).toBe(true);
    expect(warnings.some((w) => w.includes('7 voice detections'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The honest placeholder

describe('a name and a placeholder are not the same kind of thing', () => {
  function railOf(record: EntityRecord): HTMLElement {
    const rail = buildLibrary({
      onEntity: () => undefined,
      onOccurrence: () => undefined,
      onSearch: () => undefined,
    });
    rail.render(snapshot([record], [occurrence('o1', record.entityId)]), '', null);
    return rail.root;
  }

  it('marks an unnamed entity’s label as a placeholder', () => {
    // id-1: the occurrence is anonymous and the entity holds the name. id-6: names come solely
    // from the account holder. So a name-shaped string nobody said must be visibly not a name.
    const label = railOf(entity()).querySelector('.rail-name');
    expect(label?.classList.contains('is-placeholder')).toBe(true);
    expect(label?.textContent).toContain('Unnamed');
  });

  it('does not mark a real name as a placeholder', () => {
    const label = railOf(entity({ displayName: 'Julie', status: 'user_asserted' })).querySelector(
      '.rail-name',
    );
    expect(label?.classList.contains('is-placeholder')).toBe(false);
    expect(label?.textContent).toBe('Julie');
  });

  it('says which zero it is when nothing has been identified', () => {
    // "Nothing is identified" and "nothing matched your filter" are different facts, and only one
    // of them means the library is empty.
    const rail = buildLibrary({
      onEntity: () => undefined,
      onOccurrence: () => undefined,
      onSearch: () => undefined,
    });
    rail.render(snapshot([], [occurrence('o1')]), '', null);
    expect(rail.root.querySelector('.rail-empty')?.textContent).toContain('has been identified yet');
  });

  it('never renders the open-question count as a fraction or a percentage', () => {
    // 5.5: the counter is allowed to read the same number forever. There is no completion metric
    // anywhere in this product, so there must be nothing here a progress ring could be built from.
    const rail = buildLibrary({
      onEntity: () => undefined,
      onOccurrence: () => undefined,
      onSearch: () => undefined,
    });
    rail.render(snapshot([entity({ openQuestionCount: 3 })], []), '', null);
    const counter = rail.root.querySelector('.rail-counter')?.textContent ?? '';
    expect(counter).toBe('3 open questions');
    expect(counter).not.toMatch(/%|\bof\b|\/|\bcomplete\b/);
  });
});

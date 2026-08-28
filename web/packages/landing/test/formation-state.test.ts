import { describe, expect, it } from 'vitest';

import {
  elapsedMs,
  formationVisual,
  initialFormationState,
  progressFraction,
  reduceFormation,
  withStreamState,
  type StageEvent,
} from '../src/formation/index.js';

const CAPTURE = 'c1';

function event(partial: Partial<StageEvent> & Pick<StageEvent, 'phase' | 'stageIndex' | 'at'>): StageEvent {
  return { eventId: `e${partial.at}`, captureId: CAPTURE, ...partial };
}

describe('the reducer never invents a number', () => {
  it('reports no fraction when the total is unknown', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'media_extraction', stageIndex: 1, at: 10, counters: { done: 34, total: null } }));
    expect(s.counters).toEqual({ done: 34, total: null });
    expect(progressFraction(s)).toBeNull();
  });

  it('reports no fraction when the stage sent no counters at all', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'reconstruction', stageIndex: 3, at: 10 }));
    expect(progressFraction(s)).toBeNull();
    expect(formationVisual(s).resolved).toBeNull();
    expect(formationVisual(s).motion).toBe('breathe');
  });

  it('does not carry a previous stage counter into a stage that has not counted', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'media_extraction', stageIndex: 1, at: 10, counters: { done: 148, total: 148 } }));
    expect(progressFraction(s)).toBe(1);
    s = reduceFormation(s, event({ phase: 'camera_recovery', stageIndex: 2, at: 20 }));
    expect(s.counters).toBeNull();
    expect(progressFraction(s)).toBeNull();
  });

  it('measures elapsed time from server timestamps only', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'received', stageIndex: 0, at: 1000, photographs: 148 }));
    s = reduceFormation(s, event({ phase: 'media_extraction', stageIndex: 1, at: 4500 }));
    expect(elapsedMs(s)).toBe(3500);
  });
});

describe('delivery order', () => {
  it('drops a replayed earlier stage rather than walking the visual backwards', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'entity_indexing', stageIndex: 4, at: 50, detections: { people: 12, objects: 4, places: 2 } }));
    const back = reduceFormation(s, event({ phase: 'media_extraction', stageIndex: 1, at: 60, counters: { done: 9, total: 148 } }));
    expect(back.phase).toBe('entity_indexing');
    expect(back.counters).toBeNull();
  });

  it('ignores an event for a different capture', () => {
    const s = initialFormationState(CAPTURE);
    const other = reduceFormation(s, { eventId: 'x', captureId: 'other', phase: 'ready', stageIndex: 6, at: 1 });
    expect(other).toBe(s);
  });

  it('rejects a negative count instead of repairing it', () => {
    const s = initialFormationState(CAPTURE);
    expect(() =>
      reduceFormation(s, event({ phase: 'media_extraction', stageIndex: 1, at: 1, counters: { done: -3, total: 10 } })),
    ).toThrow(/non-negative/);
  });
});

describe('the visual is a function of real counts', () => {
  it('draws exactly one anchor mote per detection that landed', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'entity_indexing', stageIndex: 4, at: 10, detections: { people: 12, objects: 4, places: 2 } }));
    expect(formationVisual(s).anchorMotes).toBe(18);
  });

  it('draws exactly one thread per candidate link compared', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'continuity_search', stageIndex: 5, at: 10, counters: { done: 2, total: 2 } }));
    expect(formationVisual(s).threads).toBe(2);
  });

  it('freezes when the stream is lost, rather than continuing optimistically', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'camera_recovery', stageIndex: 2, at: 10, counters: { done: 91, total: 148 } }));
    s = withStreamState(s, 'lost');
    expect(formationVisual(s).motion).toBe('frozen');
    // The last measured fraction is still reported, because it is still the last thing we know.
    expect(progressFraction(s)).toBeCloseTo(91 / 148);
  });

  it('derives dissolve from open questions over indexed detections', () => {
    let s = initialFormationState(CAPTURE);
    s = reduceFormation(s, event({ phase: 'entity_indexing', stageIndex: 4, at: 10, detections: { people: 6, objects: 2, places: 2 } }));
    s = reduceFormation(s, event({ phase: 'ready', stageIndex: 6, at: 20, outcome: { rung: 3, openQuestions: 5, photographsAvailable: 148 } }));
    expect(formationVisual(s).dissolve).toBeCloseTo(0.5);
    expect(formationVisual(s).motion).toBe('settled');
  });
});

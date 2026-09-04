// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { FormationState, StageEvent } from '@exulanica/formation';
import { initialFormationState, reduceFormation, withStreamState } from '@exulanica/formation';

import { buildFormation } from '../src/ui/formation.js';

/**
 * The forming panel, driven through the real reducer.
 *
 * Racing a live ingest to catch a mid-flight frame is not a test, it is a coin toss: an offline
 * ingest of 150 photographs finishes before a page finishes loading. So the states are built by
 * feeding the shared reducer the events the server actually emits, which is both deterministic
 * and closer to what is under test: the panel's job is to render whatever state the reducer is in.
 *
 * The rule every assertion here serves is interaction-model.md 8.1: "There is no synthetic
 * progress bar and no invented percentage."
 */

function midFlight(): FormationState {
  const events: StageEvent[] = [
    { eventId: 'received', captureId: 'b1', phase: 'received', stageIndex: 0, at: 1000, photographs: 148 },
    {
      eventId: 'e1',
      captureId: 'b1',
      phase: 'media_extraction',
      stageIndex: 1,
      at: 2000,
      counters: { done: 62, total: 148 },
    },
  ];
  return events.reduce(reduceFormation, initialFormationState('b1'));
}

function unmeasured(): FormationState {
  return reduceFormation(midFlight(), {
    eventId: 'e2',
    captureId: 'b1',
    phase: 'continuity_search',
    stageIndex: 5,
    at: 9000,
  });
}

function ready(): FormationState {
  return reduceFormation(midFlight(), {
    eventId: 'ready',
    captureId: 'b1',
    phase: 'ready',
    stageIndex: 6,
    at: 10_000,
    outcome: { rung: 4, openQuestions: 0, photographsAvailable: 148 },
  });
}

function render(state: FormationState, label: string | null = 'my upload'): HTMLElement {
  const panel = buildFormation();
  panel.render(state, label);
  return panel.root;
}

describe('the forming panel', () => {
  it('names the real pipeline stage', () => {
    expect(render(midFlight()).querySelector('.forming-stage')?.textContent).toBeTruthy();
  });

  it('renders no percentage anywhere, at any stage', () => {
    for (const state of [midFlight(), unmeasured(), withStreamState(midFlight(), 'lost')]) {
      const text = render(state).textContent ?? '';
      expect(text, text).not.toMatch(/\d+\s*%/);
    }
  });

  it('contains nothing a progress bar could be drawn in', () => {
    // Structural, not cosmetic. A rule kept by having nowhere to put the thing is kept better
    // than one kept by remembering not to.
    const root = render(midFlight());
    expect(root.querySelectorAll('progress, [role="progressbar"], meter')).toHaveLength(0);
    for (const node of root.querySelectorAll<HTMLElement>('*')) {
      expect(node.getAttribute('style') ?? '').not.toMatch(/width\s*:\s*\d/);
    }
  });

  it('shows the counted pair in words rather than as a fraction of a whole', () => {
    const text = render(midFlight()).textContent ?? '';
    expect(text).toContain('62');
    expect(text).toContain('148');
  });

  it('shows elapsed time only where there is nothing measurable to report', () => {
    // 8.3: "if progress is not measurable, the visual breathes rather than advances, and the
    // label shows elapsed time". Elapsed time beside a real count is noise, and the label is
    // what decides which of the two a state is.
    expect(render(midFlight()).querySelector('.forming-elapsed')).toBeNull();
    expect(render(unmeasured()).querySelector('.forming-elapsed')).not.toBeNull();
  });

  it('says the counts are stale when contact was lost, rather than showing them as current', () => {
    const text = render(withStreamState(midFlight(), 'lost')).textContent ?? '';
    expect(text.toLowerCase()).toContain('lost');
  });

  it('keeps the pipeline’s own message out of the honest sentence', () => {
    const noted = reduceFormation(midFlight(), {
      eventId: 'e3',
      captureId: 'b1',
      phase: 'media_extraction',
      stageIndex: 1,
      at: 3000,
      note: 'decoder retried once',
    });
    const root = render(noted);
    expect(root.querySelector('.forming-note')?.textContent).toContain('decoder retried once');
    expect(root.querySelector('.forming-headline')?.textContent).not.toContain('decoder retried');
  });

  it('hides itself when nothing is forming, rather than showing an empty frame', () => {
    const panel = buildFormation();
    panel.render(null, null);
    expect(panel.root.hidden).toBe(true);
  });

  it('hides the completed receipt once the region is ready', () => {
    const panel = buildFormation();
    panel.render(ready(), '.exulanica/media/intake/synthetic');
    expect(panel.root.hidden).toBe(true);
    expect(panel.root.textContent).toBe('');
  });
});

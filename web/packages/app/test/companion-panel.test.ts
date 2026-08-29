// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Turn, TurnOption } from '@orimera/companion-runtime';
import { buildCompanionPanel } from '../src/ui/companion-panel.js';

/**
 * The rules the Companion's panel carries, checked against what actually renders.
 *
 * Each of these is the kind of thing that looks like a tidy-up: drop the options nobody can
 * pick, move the escapes into a menu, bind Escape to close the panel. They are asserted here so
 * the next person finds out from a red suite rather than from a reviewer.
 */

const NOOP = {
  onDismiss: () => undefined,
  onSelect: () => undefined,
  onSubmit: () => undefined,
  onSay: () => undefined,
  onEvidence: () => undefined,
};

/** The panel starts as a prompt. A turn only renders once it has been summoned. */
function opened(handlers: Parameters<typeof buildCompanionPanel>[0] = NOOP) {
  const panel = buildCompanionPanel(handlers);
  panel.setState('open');
  return panel;
}

function option(over: Partial<TurnOption> = {}): TurnOption {
  return {
    optionId: 'opt-1',
    kind: 'assert',
    textKey: 'option.yes',
    phrasing: 'Yes, that is her',
    available: true,
    unavailableReasonKey: null,
    tier: 1,
    draft: null,
    escape: null,
    ...over,
  } as TurnOption;
}

function turn(over: Partial<Turn> = {}): Turn {
  return {
    turnId: 't1',
    intent: 'identify' as Turn['intent'],
    subjectEntityId: null,
    subjectAnchorId: null,
    utteranceKey: 'ask.identity',
    utterance: 'Is this the same person as in the earlier photograph?',
    evidence: [],
    choiceSet: { mode: 'single', options: [option()], submitRequired: false },
    freeTextAllowed: true,
    escapes: [
      option({ optionId: 'e1', textKey: 'escape.unsure', phrasing: 'Not sure', escape: 'not_sure' }),
      option({ optionId: 'e2', textKey: 'escape.skip', phrasing: 'Skip', escape: 'skip' }),
      option({ optionId: 'e3', textKey: 'escape.later', phrasing: 'Later', escape: 'later' }),
      option({ optionId: 'e4', textKey: 'escape.wrong', phrasing: 'Wrong question', escape: 'wrong_question' }),
    ],
    stateVersion: 1,
    ...over,
  } as Turn;
}

describe('unavailable options are delivered, not hidden', () => {
  it('renders an unavailable option with its reason and disables it', () => {
    const panel = opened();
    panel.render(
      turn({
        choiceSet: {
          mode: 'single',
          options: [
            option(),
            option({
              optionId: 'opt-2',
              phrasing: 'Merge the two people',
              available: false,
              unavailableReasonKey: 'unavailable.needsConfirmedLink',
            }),
          ],
          submitRequired: false,
        },
      }),
    );

    const buttons = panel.root.querySelectorAll('.options .option');
    expect(buttons).toHaveLength(2);
    // Hiding it would teach the user nothing; showing the reason teaches them what is missing.
    expect(buttons[1]?.hasAttribute('disabled')).toBe(true);
    expect(panel.root.querySelector('.unavailable .why')?.textContent ?? '').not.toBe('');
  });
});

describe('the escapes are always present', () => {
  it('renders all four, every turn', () => {
    const panel = opened();
    panel.render(turn());
    expect(panel.root.querySelectorAll('.escapes .option')).toHaveLength(4);
  });

  it('offers them even when the turn has no choice set at all', () => {
    const panel = opened();
    panel.render(turn({ choiceSet: null }));
    expect(panel.root.querySelectorAll('.escapes .option')).toHaveLength(4);
  });
});

describe('the panel never takes Escape', () => {
  it('is not a dialog element', () => {
    const panel = opened();
    // A <dialog> takes Escape for free. Escape releases the mouse and nothing else, everywhere.
    expect(panel.root.tagName.toLowerCase()).toBe('aside');
  });

  it('leaves Escape unhandled in the free text field', () => {
    let said = 0;
    const panel = opened({ ...NOOP, onSay: () => (said += 1) });
    panel.render(turn());
    const input = panel.root.querySelector('input.free');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(said).toBe(0);
  });
});

describe('a multi select cannot commit by clicking', () => {
  it('requires an explicit submit', () => {
    const picked: string[][] = [];
    const panel = opened({ ...NOOP, onSubmit: (ids) => picked.push([...ids]) });
    panel.render(
      turn({
        choiceSet: {
          mode: 'multi',
          options: [option(), option({ optionId: 'opt-2', phrasing: 'And her sister' })],
          submitRequired: true,
        },
      }),
    );

    const boxes = panel.root.querySelectorAll<HTMLInputElement>('.options input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    boxes[0]!.checked = true;
    // Ticking a box must not commit anything on its own.
    expect(picked).toHaveLength(0);
    panel.root.querySelector<HTMLButtonElement>('button.primary')?.click();
    expect(picked).toEqual([['opt-1']]);
  });
});

describe('a refusal is reported in the words the refusal used', () => {
  it('shows the reason rather than a friendlier invention', () => {
    const panel = opened();
    panel.render(turn());
    panel.reportRefusal('refused.tierNotOfferableHere');
    expect(panel.root.querySelector('.refusal')?.textContent ?? '').not.toBe('');
  });
});

describe('nothing stands on screen until it is called', () => {
  it('shows how to get into the world while the mouse is free', () => {
    const panel = buildCompanionPanel(NOOP);
    expect(panel.state()).toBe('enter');
    expect(panel.root.querySelector('.prompt')?.textContent ?? '').toContain('Click');
    expect(panel.root.querySelector('.options')).toBeNull();
  });

  it('offers the summon key once the user is in the world', () => {
    const panel = buildCompanionPanel(NOOP);
    panel.setState('summon');
    expect(panel.root.querySelector('.prompt')?.textContent ?? '').toContain('X');
    expect(panel.root.querySelector('.escapes')).toBeNull();
  });

  it('keeps the turn while dismissed, so summoning resumes rather than re-asks', () => {
    const panel = buildCompanionPanel(NOOP);
    panel.setState('open');
    panel.render(turn());
    const asked = panel.root.querySelector('.utterance')?.textContent;
    panel.setState('summon');
    expect(panel.root.querySelector('.utterance')).toBeNull();
    panel.setState('open');
    expect(panel.root.querySelector('.utterance')?.textContent).toBe(asked);
  });
});

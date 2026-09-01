// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Turn, TurnOption } from '@orimera/companion-runtime';
import { buildCompanionPanel } from '../src/ui/companion-panel.js';

/**
 * The rules the Companion's panel carries, checked against what actually renders.
 *
 * Each of these is the kind of thing that looks like a tidy-up but changes the interaction
 * contract. They are asserted here so the next person finds out from a red suite rather than from
 * a reviewer.
 */

const NOOP = {
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

    const buttons = panel.root.querySelectorAll(
      '.companion-choices > .choice-item:not(.companion-other) .companion-choice',
    );
    expect(buttons).toHaveLength(2);
    // Hiding it would teach the user nothing; showing the reason teaches them what is missing.
    expect(buttons[1]?.hasAttribute('disabled')).toBe(true);
    expect(panel.root.querySelector('.choice-unavailable-reason')?.textContent ?? '').not.toBe('');
  });
});

describe('the choice rail stays separate from the Companion speech', () => {
  it('keeps uncertainty, skip, and correction available while Escape replaces later', () => {
    const panel = opened();
    panel.render(turn());
    const escapes = [...panel.root.querySelectorAll('.companion-escapes .companion-choice')].map(
      (element) => element.textContent,
    );
    expect(escapes).toEqual(['Not sure', 'Skip', 'Wrong question']);
    expect(panel.root.querySelector('.companion-speech + .companion-choice-rail')).not.toBeNull();
  });

  it('keeps the three non-dismiss escapes even when there is no choice set', () => {
    const panel = opened();
    panel.render(turn({ choiceSet: null }));
    expect(panel.root.querySelectorAll('.companion-escapes .companion-choice')).toHaveLength(3);
  });
});

describe('dismissal belongs to the shell rather than a floating close button', () => {
  it('stays an aside and renders no close glyph', () => {
    const panel = opened();
    expect(panel.root.tagName.toLowerCase()).toBe('aside');
    expect(panel.root.querySelector('.panel-close')).toBeNull();
  });

  it('does not consume Escape inside the free text field', () => {
    let said = 0;
    const panel = opened({ ...NOOP, onSay: () => (said += 1) });
    panel.render(turn());
    const input = panel.root.querySelector('input.companion-reply-input');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(said).toBe(0);
  });
});

describe('the exchange stays subordinate to the Companion presence', () => {
  it('renders no redundant header and exposes evidence as an action', () => {
    const panel = opened();
    panel.render(turn({ evidence: ['evidence-1'] }));

    expect(panel.root.querySelector('.companion-head')).toBeNull();
    expect(panel.root.querySelector('.companion-utterance')?.textContent).toContain(
      'same person',
    );
    expect(panel.root.querySelector('.companion-evidence')?.getAttribute('aria-label')).toBe(
      'Memory evidence',
    );
    expect(panel.root.querySelector('.companion-evidence-action')?.textContent).toBe(
      'Show supporting memory',
    );
    expect(panel.root.querySelector('.companion-speaker')?.textContent).toBe('Unnamed Companion');
  });

  it('offers app-owned design deep links without making them graph options', () => {
    const onCustomizeCompanion = vi.fn();
    const onCustomizeWorld = vi.fn();
    const panel = opened({ ...NOOP, onCustomizeCompanion, onCustomizeWorld });
    panel.render(turn());
    const links = panel.root.querySelectorAll<HTMLButtonElement>('.companion-utilities button');
    expect([...links].map((button) => button.textContent)).toEqual(['Design Companion', 'Design World']);
    links[0]?.click();
    links[1]?.click();
    expect(onCustomizeCompanion).toHaveBeenCalledOnce();
    expect(onCustomizeWorld).toHaveBeenCalledOnce();
    expect(panel.root.querySelectorAll('.companion-choices > .choice-item')).not.toHaveLength(0);
  });

  it('renders free text as the next numbered option and removes the text Send control', () => {
    const panel = opened();
    panel.render(
      turn({
        choiceSet: {
          mode: 'single',
          options: [
            option(),
            option({ optionId: 'opt-2' }),
            option({ optionId: 'opt-3' }),
          ],
          submitRequired: false,
        },
      }),
    );
    const custom = panel.root.querySelector('.companion-composer');
    const reveal = panel.root.querySelector<HTMLButtonElement>('.companion-other-reveal');
    expect(reveal?.textContent).toContain('4');
    expect(reveal?.textContent).toContain('Other');
    expect(custom?.hasAttribute('hidden')).toBe(true);
    reveal?.click();
    expect(custom?.hasAttribute('hidden')).toBe(false);
    expect(panel.root.querySelector('.companion-reply-submit')?.getAttribute('aria-label')).toBe(
      'Send reply',
    );
    expect(panel.root.textContent).not.toContain('Send');
  });

  it('opens Other from its number key without committing a graph option', () => {
    const panel = opened();
    panel.render(turn());
    expect(panel.pressNumber(2)).toBe(true);
    expect(panel.root.querySelector('.companion-composer')?.hasAttribute('hidden')).toBe(false);
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

    const boxes = panel.root.querySelectorAll<HTMLInputElement>('.choice-checkbox');
    expect(boxes).toHaveLength(2);
    boxes[0]!.checked = true;
    // Ticking a box must not commit anything on its own.
    expect(picked).toHaveLength(0);
    panel.root.querySelector<HTMLButtonElement>('.companion-choices-submit')?.click();
    expect(picked).toEqual([['opt-1']]);
  });
});

describe('a refusal is reported in the words the refusal used', () => {
  it('shows the reason rather than a friendlier invention', () => {
    const panel = opened();
    panel.render(turn());
    panel.reportRefusal('refused.tierNotOfferableHere');
    expect(panel.root.querySelector('.companion-refusal')?.textContent ?? '').not.toBe('');
  });
});

describe('confirmation suspends duplicate answer controls', () => {
  it('removes the answer rail from interaction until the proposal is dismissed', () => {
    const panel = opened();
    panel.render(turn());
    const rail = panel.root.querySelector<HTMLElement>('.companion-choice-rail')!;

    panel.setConfirming(true);
    expect(rail.inert).toBe(true);
    expect(rail.getAttribute('aria-hidden')).toBe('true');

    panel.setConfirming(false);
    expect(rail.inert).toBe(false);
    expect(rail.getAttribute('aria-hidden')).toBe('false');
  });
});

describe('nothing stands on screen until it is called', () => {
  it('uses the existing prompt surface for first-use meaning and action', () => {
    const panel = buildCompanionPanel(NOOP);
    panel.setFirstUsePrompt({
      statement: 'Atlas arranges your memories as a world.',
      actions: [{ label: 'Click to enter' }],
    });
    expect(panel.root.hasAttribute('data-first-use')).toBe(true);
    expect(panel.root.querySelector('.companion-prompt-statement')?.textContent).toContain(
      'memories as a world',
    );
    expect(panel.root.querySelector('.companion-prompt-actions')?.textContent).toContain(
      'Click to enter',
    );
    expect(panel.root.querySelector('.companion-speech')).toBeNull();
  });

  it('renders the unnamed Companion call as one compact instruction', () => {
    const panel = buildCompanionPanel(NOOP);
    panel.setFirstUsePrompt({
      statement: 'Press',
      actions: [{ key: 'X', label: 'to call Unnamed Companion' }],
      compact: true,
    });
    expect(panel.root.hasAttribute('data-compact-prompt')).toBe(true);
    expect(panel.root.querySelector('.companion-prompt-statement')?.textContent).toBe('Press');
    expect(panel.root.querySelector('.companion-prompt')?.textContent ?? '').toContain(
      'PressXto call Unnamed Companion',
    );
  });

  it('shows how to get into the world while the mouse is free', () => {
    const panel = buildCompanionPanel(NOOP);
    expect(panel.state()).toBe('enter');
    expect(panel.root.querySelector('.companion-prompt')?.textContent ?? '').toContain('Click');
    expect(panel.root.querySelector('.companion-choices')).toBeNull();
  });

  it('offers the summon key once the user is in the world', () => {
    const panel = buildCompanionPanel(NOOP);
    panel.setState('summon');
    expect(panel.root.querySelector('.companion-prompt')?.textContent ?? '').toContain(
      'Press X to call Unnamed Companion',
    );
    expect(panel.root.querySelector('.companion-escapes')).toBeNull();
  });

  it('returns to the ordinary summon copy after first-use guidance completes', () => {
    const panel = buildCompanionPanel(NOOP);
    panel.setState('summon');
    panel.setFirstUsePrompt({
      statement: 'Move through this memory.',
      actions: [{ key: 'X', label: 'Companion' }],
    });
    panel.setFirstUsePrompt(null);
    expect(panel.root.hasAttribute('data-first-use')).toBe(false);
    expect(panel.root.querySelector('.companion-prompt')?.textContent ?? '').toContain('X');
    expect(panel.root.textContent).not.toContain('Move through this memory');
  });

  it('keeps the turn while dismissed, so summoning resumes rather than re-asks', () => {
    const panel = buildCompanionPanel(NOOP);
    panel.setState('open');
    panel.render(turn());
    const asked = panel.root.querySelector('.companion-utterance')?.textContent;
    panel.setState('summon');
    expect(panel.root.querySelector('.companion-utterance')).toBeNull();
    panel.setState('open');
    expect(panel.root.querySelector('.companion-utterance')?.textContent).toBe(asked);
  });
});

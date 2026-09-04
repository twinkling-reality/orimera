import { describe, expect, it } from 'vitest';
import type {
  CompanionSession,
  ConfirmationSummary,
  SelectionOutcome,
  Turn,
} from '@exulanica/companion-runtime';

import { createCompanionController } from '../src/companion.js';

describe('Companion confirmation handoff', () => {
  it('passes the selected answer wording instead of the question', () => {
    const turn = {
      turnId: 'turn-1',
      intent: 'confirm_continuity',
      subjectEntityId: 'entity-1',
      subjectAnchorId: 'anchor-1',
      utteranceKey: 'utterance.confirmContinuity',
      utterance: 'These two moments may show the same person. Do they?',
      evidence: [],
      choiceSet: {
        mode: 'single',
        submitRequired: false,
        options: [{
          optionId: 'same-person',
          kind: 'exclusive',
          textKey: 'option.yesSamePerson',
          phrasing: 'Yes, the same person',
          available: true,
          unavailableReasonKey: null,
          tier: 2,
          draft: null,
          escape: null,
        }],
      },
      freeTextAllowed: true,
      escapes: [],
      stateVersion: 1,
    } as unknown as Turn;
    const outcome = {
      kind: 'awaiting_confirmation',
      proposal: { proposalId: 'proposal-1' },
      confirmation: {},
    } as unknown as SelectionOutcome;
    const companion = {
      advance: () => turn,
      select: () => outcome,
    } as unknown as CompanionSession;
    let answer = '';
    const controller = createCompanionController({
      companion,
      onAwaitingConfirmation: (_proposalId, _summary: ConfirmationSummary, utterance) => {
        answer = utterance;
      },
    });

    controller.summon(0);
    controller.select('same-person');

    expect(answer).toBe('Yes, the same person');
    expect(answer).not.toBe(turn.utterance);
  });
});

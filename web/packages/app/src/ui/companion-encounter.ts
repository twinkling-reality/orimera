import type { Turn } from '@orimera/companion-runtime';
import {
  buildCompanionChoiceRail,
  type CompanionChoiceHandlers,
} from './companion-choice-rail.js';
import type { CompanionPlacement } from './companion-placement.js';
import { buildCompanionSpeech } from './companion-speech.js';
import { el, replace } from './dom.js';
import type { FirstUsePrompt } from './first-use-guidance.js';

export interface CompanionHandlers extends CompanionChoiceHandlers {
  readonly onEvidence: (handleIndex: number) => void;
}

export type PanelState = 'enter' | 'summon' | 'open';

export interface CompanionEncounterOptions {
  readonly speakerName?: string;
}

export interface CompanionEncounter {
  readonly root: HTMLElement;
  setFirstUsePrompt(prompt: FirstUsePrompt | null): void;
  setConfirming(confirming: boolean): void;
  setState(state: PanelState): void;
  state(): PanelState;
  render(turn: Turn | null): void;
  reportRefusal(reasonKey: string): void;
  pressNumber(index: number): boolean;
  setPlacement(placement: CompanionPlacement): void;
  placement(): CompanionPlacement | null;
  hide(): void;
}

export function buildCompanionEncounter(
  handlers: CompanionHandlers,
  options: CompanionEncounterOptions = {},
): CompanionEncounter {
  const root = el('aside', {
    class: 'companion-encounter',
    'aria-label': 'Companion encounter',
    'aria-live': 'polite',
    'data-state': 'enter',
  });
  const speech = buildCompanionSpeech({
    speakerName: options.speakerName ?? 'Companion',
    onEvidence: handlers.onEvidence,
  });
  const choices = buildCompanionChoiceRail(handlers);
  let state: PanelState = 'enter';
  let lastTurn: Turn | null = null;
  let currentPlacement: CompanionPlacement | null = null;
  let firstUsePrompt: FirstUsePrompt | null = null;

  function renderPrompt(): void {
    root.toggleAttribute('data-first-use', firstUsePrompt !== null);
    if (firstUsePrompt !== null) {
      replace(root, [
        el('p', { class: 'companion-prompt' }, [
          el('span', { class: 'companion-prompt-statement', text: firstUsePrompt.statement }),
          el('span', { class: 'companion-prompt-actions' }, firstUsePrompt.actions.map((action) =>
            el('span', { class: 'companion-prompt-action' }, [
              ...(action.key === undefined ? [] : [el('b', { text: action.key })]),
              action.label,
            ]))),
        ]),
      ]);
      return;
    }
    replace(root, [
      el(
        'p',
        { class: 'companion-prompt' },
        state === 'enter'
          ? ['Click to look around']
          : ['Press ', el('b', { text: 'X' }), ' to summon the Companion'],
      ),
    ]);
  }

  function renderTurn(turn: Turn): void {
    speech.render(turn);
    choices.render(turn);
    replace(root, [speech.root, choices.root]);
  }

  renderPrompt();

  return {
    root,
    setFirstUsePrompt(prompt) {
      firstUsePrompt = prompt;
      if (state !== 'open') renderPrompt();
    },
    setConfirming(confirming) {
      root.toggleAttribute('data-confirming', confirming);
      choices.root.inert = confirming;
      choices.root.setAttribute('aria-hidden', confirming ? 'true' : 'false');
    },
    state: () => state,
    placement: () => currentPlacement,
    setPlacement(placement) {
      currentPlacement = placement;
      root.dataset['presenceSide'] = placement.presenceSide;
      root.dataset['speechSide'] = placement.speechSide;
      root.dataset['choicesSide'] = placement.choicesSide;
      root.dataset['placementBasis'] = placement.basis;
    },
    setState(next) {
      state = next;
      root.dataset['state'] = next;
      if (next === 'open' && lastTurn !== null) renderTurn(lastTurn);
      else renderPrompt();
    },
    render(turn) {
      lastTurn = turn;
      if (turn === null || state !== 'open') renderPrompt();
      else renderTurn(turn);
    },
    reportRefusal(reasonKey) {
      speech.reportRefusal(reasonKey);
    },
    pressNumber(index) {
      return state === 'open' ? choices.pressNumber(index) : false;
    },
    hide() {
      root.setAttribute('hidden', '');
    },
  };
}

import type { Turn } from '@orimera/companion-runtime';
import { el, replace } from './dom.js';
import { say } from './copy.js';

export interface CompanionSpeechOptions {
  readonly speakerName: string;
  readonly onEvidence: (handleIndex: number) => void;
}

export interface CompanionSpeech {
  readonly root: HTMLElement;
  render(turn: Turn): void;
  reportRefusal(reasonKey: string): void;
}

function evidenceActionLabel(turn: Turn): string {
  if (turn.intent === 'confirm_continuity') {
    return turn.evidence.length === 1 ? 'Show the other memory' : 'Compare the memories';
  }
  return turn.evidence.length === 1 ? 'Show supporting memory' : 'Review supporting memories';
}

export function buildCompanionSpeech(options: CompanionSpeechOptions): CompanionSpeech {
  const root = el('section', {
    class: 'companion-speech',
    'aria-labelledby': 'companion-speaker-name',
  });

  const render = (turn: Turn): void => {
    const content: (Node | string)[] = [
      el('h2', {
        id: 'companion-speaker-name',
        class: 'companion-speaker',
        text: options.speakerName,
      }),
      el('p', { class: 'companion-utterance', text: turn.utterance ?? say(turn.utteranceKey) }),
    ];

    if (turn.evidence.length > 0) {
      const label = evidenceActionLabel(turn);
      content.push(el(
        'ul',
        { class: 'companion-evidence', 'aria-label': 'Memory evidence' },
        turn.evidence.map((_, index) => {
          const action = el('button', {
            type: 'button',
            class: 'companion-evidence-action',
            text: turn.evidence.length === 1 ? label : `${label} ${index + 1}`,
          });
          action.addEventListener('click', () => options.onEvidence(index));
          return el('li', {}, [action]);
        }),
      ));
    }

    replace(root, content);
  };

  return {
    root,
    render,
    reportRefusal(reasonKey) {
      root.append(el('p', { class: 'companion-refusal', text: say(reasonKey) }));
    },
  };
}

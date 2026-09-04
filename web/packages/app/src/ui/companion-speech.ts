import type { Turn } from '@exulanica/companion-runtime';
import { el, replace } from './dom.js';
import { say } from './copy.js';

export interface CompanionSpeechOptions {
  readonly speakerName: string;
}

export interface CompanionSpeech {
  readonly root: HTMLElement;
  render(turn: Turn): void;
  reportRefusal(reasonKey: string): void;
}

/*
 * The band holds speech, and only speech.
 *
 * It used to carry a control that opened the cited photograph, sitting inside the sentence the
 * Companion had just spoken. Two things were wrong with it and renaming it fixed neither. It put
 * an action in the one region reserved for what the Companion says, while the rail beside it
 * exists to hold what a person can do. And it was a third route to a place already reachable two
 * ways: aiming at the memory and pressing Interact opens that occurrence's detail, and the
 * conversation's own third choice asks to see both moments. The citation did not need a button
 * inside a paragraph; it needed to be somewhere a person looks for actions, and it already was.
 */

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

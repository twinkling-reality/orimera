import { el } from './dom.js';
import { createModalFocus } from './modal-focus.js';

export interface ControlsGuide {
  readonly root: HTMLElement;
  setVisible(visible: boolean): void;
}

interface ControlsGuideOptions {
  readonly onClose: () => void;
  readonly onShowOptions: () => void;
}

const rows: readonly (readonly [string, string])[] = [
  ['W A S D', 'Move through the Atlas'],
  ['Mouse', 'Look around'],
  ['Shift', 'Move faster'],
  ['E · Space · Enter', 'Interact with what is centred'],
  ['X · Right click', 'Call the Companion'],
  ['I', 'Open the World Index'],
  ['M', 'Move between ground view and Atlas Map'],
  ['O', 'Open Options'],
  ['?', 'Show this guide'],
  ['Escape', 'Release look, or dismiss the Companion when it is open'],
];

export function buildControlsGuide(options: ControlsGuideOptions): ControlsGuide {
  const root = el('section', {
    class: 'system-overlay controls-view',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'controls-title',
  });
  root.hidden = true;
  const close = el('button', {
    type: 'button', class: 'overlay-close', 'aria-label': 'Return to Atlas', text: 'Return  ?',
  });
  close.addEventListener('click', options.onClose);
  const settings = el('button', { type: 'button', class: 'text-action', text: 'Open Options  O' });
  settings.addEventListener('click', options.onShowOptions);
  root.append(
    el('header', { class: 'overlay-head' }, [
      el('div', {}, [
        el('p', { class: 'overlay-kicker', text: 'Atlas system' }),
        el('h1', { id: 'controls-title', text: 'Controls' }),
      ]),
      close,
    ]),
    el('p', {
      class: 'controls-intro',
      text: 'Atlas arranges your memories as a world. Index reads the evidence; Map shows how those memories relate.',
    }),
    el('dl', { class: 'controls-list' }, rows.flatMap(([key, meaning]) => [
      el('dt', {}, [el('kbd', { text: key })]),
      el('dd', { text: meaning }),
    ])),
    el('footer', { class: 'overlay-actions' }, [settings]),
  );

  const modalFocus = createModalFocus(root, close);
  return {
    root,
    setVisible(visible) {
      modalFocus.setVisible(visible);
    },
  };
}

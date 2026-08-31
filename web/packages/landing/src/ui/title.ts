/** The Orimera title composition and its single explicit product entry. */

import { el } from './dom.js';

export interface TitleOptions {
  readonly atlasHref: string | null;
}

export function buildFigures(): HTMLElement {
  const wrap = el('div', { class: 'figures', 'aria-hidden': 'true' });
  for (const [side, file] of [['left', 'orimera1'], ['right', 'orimera2']] as const) {
    wrap.append(
      el('img', {
        class: `figure figure-${side}`,
        src: `/figures/${file}-1400.webp`,
        srcset: `/figures/${file}-900.webp 900w, /figures/${file}-1400.webp 1400w`,
        sizes: '31vw',
        alt: '',
        decoding: 'async',
      }),
    );
  }
  return wrap;
}

function entryLabel(): readonly HTMLElement[] {
  return [
    el('kbd', { class: 'key key-wide', text: 'Enter' }),
    el('span', { class: 'start-word', text: 'Enter Atlas' }),
  ];
}

export function buildTitle(options: TitleOptions): HTMLElement {
  const root = el('section', { id: 'title', class: 'pane pane-title', tabindex: '-1' });
  const stack = el('div', { class: 'title' });
  stack.append(
    el('p', { class: 'brandline', text: 'Orimera' }),
    el('h1', { class: 'proposition', text: 'A Personal World Memory Model' }),
  );

  if (options.atlasHref !== null) {
    stack.append(
      el(
        'a',
        { class: 'start', id: 'path-enter', href: options.atlasHref, 'aria-label': 'Enter Atlas' },
        entryLabel(),
      ),
    );
  } else {
    stack.append(
      el('p', {
        class: 'entry-status',
        role: 'status',
        text: 'Atlas is not connected in this build.',
      }),
    );
  }

  root.append(stack);
  return root;
}

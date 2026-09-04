/** Exulanica's signed-out title: one wordmark, one proposition, and one incomplete memory. */

import { el } from './dom.js';

export function buildTitle(): HTMLElement {
  const root = el('section', {
    id: 'title',
    class: 'pane pane-title',
    tabindex: '-1',
    'aria-labelledby': 'title-wordmark',
  });
  const aperture = el('div', { class: 'memory-aperture', 'aria-hidden': 'true' });
  aperture.append(el('div', { class: 'memory-crescent' }));

  const stack = el('div', { class: 'title' });
  stack.append(
    el('h1', { class: 'wordmark', id: 'title-wordmark', text: 'Exulanica' }),
    el('p', { class: 'proposition', text: 'A personal world memory model' }),
  );

  const publisher = el('p', { class: 'publisher-mark' }, [
    el('span', { text: '© 2026 ' }),
    el('span', { text: 'Twinkling Reality' }),
  ]);

  root.append(aperture, stack, publisher);
  return root;
}

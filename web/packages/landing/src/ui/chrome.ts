/**
 * One signed-out top bar, built once and shared by the title and Method surfaces. Destinations
 * keep the same order and interaction; only the current marker and Home affordance change.
 */

import { el } from './dom.js';

export const REPOSITORY_URL = 'https://github.com/twinkling-reality/orimera';
/** The documents this page is built from, which are the same ones it is checked against. */
export const DOCS_URL = `${REPOSITORY_URL}/tree/main/docs`;

/** Where the visitor is. The bar marks the current one and offers Home from everywhere else. */
export type Surface = 'title' | 'method';

export interface ChromeActions {
  onHome(): void;
  onMethod(): void;
}

/**
 * One destination: a key chip and a label.
 *
 * The chip is not decoration. Every key shown here is really bound, so the bar reads as a legend
 * for the keyboard rather than as a costume borrowed from a game menu. A hint that did nothing
 * would be worse than no hint at all.
 */
function destination(
  key: string,
  label: string,
  id: string,
  onPick: () => void,
  href?: string,
): HTMLElement {
  const inner = [
    el('kbd', { class: 'key', text: key }),
    el('span', { class: 'destination-label', text: label }),
  ];
  if (href !== undefined) {
    return el('a', { class: 'destination', id, href, rel: 'noreferrer' }, inner);
  }
  const b = el('button', { type: 'button', class: 'destination', id }, inner);
  b.addEventListener('click', onPick);
  return b;
}

export interface Chrome {
  readonly root: HTMLElement;
  setSurface(surface: Surface): void;
}

export function buildChrome(actions: ChromeActions): Chrome {
  const bar = el('nav', { class: 'topbar', 'aria-label': 'Site' });

  const home = destination('H', 'Home', 'path-home', actions.onHome);
  const method = destination('M', 'Method', 'path-how', actions.onMethod);

  const left = el('div', { class: 'destinations' });
  left.append(
    home,
    method,
    destination('D', 'Docs', 'path-docs', () => {}, DOCS_URL),
    destination('G', 'GitHub', 'path-github', () => {}, REPOSITORY_URL),
  );

  bar.append(left);

  return {
    root: bar,
    setSurface(surface) {
      // Home is the way back, so it is not offered from the place it goes to.
      home.hidden = surface === 'title';
      // `aria-current` rather than a class alone, so the marking is not purely visual.
      for (const [node, owns] of [[method, surface === 'method']] as const) {
        if (owns) node.setAttribute('aria-current', 'page');
        else node.removeAttribute('aria-current');
      }
    },
  };
}

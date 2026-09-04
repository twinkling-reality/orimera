/**
 * One signed-out navigation set, built once and shared by the title and Method surfaces. Destinations
 * keep the same order and interaction; only the current marker and Home affordance change.
 */

import { el } from './dom.js';
import { createCompanionMenuMarker } from './companion-menu-marker.js';

export const REPOSITORY_URL = 'https://github.com/twinkling-reality/exulanica';
/** The documents this page is built from, which are the same ones it is checked against. */
export const DOCS_URL = `${REPOSITORY_URL}/tree/main/docs`;

/** Where the visitor is. The bar marks the current one and offers Home from everywhere else. */
export type Surface = 'title' | 'method';

export interface ChromeActions {
  onHome(): void;
  onMethod(): void;
}

export interface ChromeOptions extends ChromeActions {
  readonly atlasHref: string | null;
}

/**
 * One destination. Every item remains a native link or button, so the game-title hierarchy does
 * not compromise ordinary browser and assistive-technology navigation.
 */
function destination(
  label: string,
  id: string,
  onPick: () => void,
  href?: string,
  primary = false,
): HTMLElement {
  const inner = [el('span', { class: 'destination-label', text: label })];
  const attrs: Record<string, string> = {
    class: primary ? 'destination destination-primary' : 'destination',
    id,
  };
  if (href !== undefined) {
    return el('a', { ...attrs, href, rel: 'noreferrer' }, inner);
  }
  const b = el('button', { ...attrs, type: 'button' }, inner);
  b.addEventListener('click', onPick);
  return b;
}

export interface Chrome {
  readonly root: HTMLElement;
  setSurface(surface: Surface): void;
}

export function buildChrome(options: ChromeOptions): Chrome {
  const bar = el('nav', { class: 'topbar', 'aria-label': 'Primary navigation' });

  const home = destination('Home', 'path-home', options.onHome);
  const method = destination('Method', 'path-how', options.onMethod);
  const atlas =
    options.atlasHref === null
      ? el('p', {
          class: 'entry-status',
          role: 'status',
          text: 'Atlas is not connected in this build.',
        })
      : destination('Enter Atlas', 'path-enter', () => {}, options.atlasHref, true);

  const left = el('div', { class: 'destinations' });
  const marker = createCompanionMenuMarker();
  const documentation = destination('Documentation', 'path-docs', () => {}, DOCS_URL);
  const github = destination('GitHub', 'path-github', () => {}, REPOSITORY_URL);
  left.append(
    marker,
    home,
    atlas,
    method,
    documentation,
    github,
  );

  const defaultTarget = atlas.matches('a, button') ? atlas : method;
  const targets = atlas.matches('a, button')
    ? [atlas, method, documentation, github]
    : [method, documentation, github];
  let currentSurface: Surface = 'title';
  let hovered: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let previousTarget = defaultTarget;
  let motionPhase = false;

  const placeMarker = (): void => {
    marker.toggleAttribute('hidden', currentSurface !== 'title');
    if (marker.hasAttribute('hidden')) return;
    const target = focused ?? hovered ?? defaultTarget;
    marker.dataset['state'] = focused !== null || hovered !== null ? 'attending' : 'resting';
    marker.dataset['target'] = target.id;
    if (target !== previousTarget) {
      const previousIndex = targets.indexOf(previousTarget);
      const nextIndex = targets.indexOf(target);
      const direction = nextIndex >= previousIndex ? 'down' : 'up';
      const distance = Math.max(1, Math.abs(nextIndex - previousIndex));
      marker.style.setProperty('--companion-travel-ms', `${Math.min(400, 280 + (distance - 1) * 60)}ms`);
      motionPhase = !motionPhase;
      marker.dataset['motion'] = `${direction}-${motionPhase ? 'a' : 'b'}`;
      previousTarget = target;
    }
    requestAnimationFrame(() => {
      marker.style.setProperty(
        '--companion-marker-y',
        `${target.offsetTop + target.offsetHeight / 2}px`,
      );
      requestAnimationFrame(() => {
        marker.dataset['positioned'] = 'true';
      });
    });
  };

  for (const target of targets) {
    target.addEventListener('pointerenter', () => {
      hovered = target;
      placeMarker();
    });
    target.addEventListener('pointerleave', () => {
      if (hovered === target) hovered = null;
      placeMarker();
    });
    target.addEventListener('focus', () => {
      focused = target;
      placeMarker();
    });
    target.addEventListener('blur', () => {
      if (focused === target) focused = null;
      placeMarker();
    });
  }

  bar.append(left);

  return {
    root: bar,
    setSurface(surface) {
      currentSurface = surface;
      // Home is the way back, so it is not offered from the place it goes to.
      home.hidden = surface === 'title';
      // Enter Atlas belongs to the title menu; Method keeps a compact way home instead.
      atlas.hidden = surface !== 'title';
      // `aria-current` rather than a class alone, so the marking is not purely visual.
      for (const [node, owns] of [[method, surface === 'method']] as const) {
        if (owns) node.setAttribute('aria-current', 'page');
        else node.removeAttribute('aria-current');
      }
      placeMarker();
    },
  };
}

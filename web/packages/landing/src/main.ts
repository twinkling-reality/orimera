/**
 * Orimera's signed-out surfaces: the title and Method.
 *
 * The Atlas itself has one composition root in `@orimera/app`. The landing page does not build a
 * second Atlas, second Companion, or scripted formation journey. Entering follows the configured
 * Atlas destination, so development, preview, and deployment all cross the same explicit boundary.
 */

import '@orimera/presentation/tokens.css';
import './style.css';

import { atlasDestinationFromEnvironment } from './atlas-destination.js';
import { readEnv, watchReducedMotion } from './env.js';
import { buildChrome, type Surface } from './ui/chrome.js';
import { buildMethod } from './ui/method.js';
import { buildFigures, buildTitle } from './ui/title.js';
import { boundaryReason, buildViewportBoundary, readViewport } from './ui/viewport-boundary.js';

const overlay = document.getElementById('overlay');
if (!overlay) throw new Error('landing: expected #overlay in the document');

const env = readEnv();
const destination = atlasDestinationFromEnvironment(window.location.href);
const title = buildTitle({ atlasHref: destination?.href ?? null });
const method = buildMethod();
const chrome = buildChrome({
  onHome: () => go('title'),
  onMethod: () => go('method'),
});

overlay.append(buildFigures(), chrome.root, title, method);

const PANES: Readonly<Record<Surface, HTMLElement>> = { title, method };
let surface: Surface = 'title';
go('title');

/** Show a signed-out surface without constructing or pretending to enter an Atlas. */
function go(next: Surface): void {
  surface = next;
  document.documentElement.dataset['surface'] = next;
  document.documentElement.dataset['ground'] = 'pale';
  document.documentElement.dataset['theme'] = 'dawn';
  chrome.setSurface(next);

  for (const [key, pane] of Object.entries(PANES) as [Surface, HTMLElement][]) {
    pane.hidden = key !== next;
  }

  const shown = PANES[next];
  shown.classList.add('is-faded');
  requestAnimationFrame(() => shown.classList.remove('is-faded'));
  shown.focus({ preventScroll: true });
}

/**
 * Keyboard legend for the signed-out surfaces.
 *
 * Escape remains unbound. Modified presses are left to the browser, and a focused control keeps
 * its native keyboard behavior. Entering Atlas clicks the same link as pointer input.
 */
window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (document.documentElement.dataset['blocked'] === 'true') return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('button, a, input, textarea, select')) return;

  const follow = (id: string): void => document.getElementById(id)?.click();
  switch (event.key.toLowerCase()) {
    case 'enter':
    case ' ':
      if (surface !== 'title' || destination === null) return;
      event.preventDefault();
      follow('path-enter');
      return;
    case 'h':
      event.preventDefault();
      go('title');
      return;
    case 'm':
      event.preventDefault();
      go('method');
      return;
    case 'd':
      follow('path-docs');
      return;
    case 'g':
      follow('path-github');
      return;
    default:
  }
});

const boundary = buildViewportBoundary();
document.body.append(boundary.root);

let lastReason: string | null | undefined;
function checkViewport(): void {
  const reason = boundaryReason(readViewport());
  if (reason === lastReason) return;
  lastReason = reason;
  boundary.apply(reason);
}
checkViewport();

window.addEventListener('resize', checkViewport);
window.matchMedia('(pointer: coarse)').addEventListener('change', checkViewport);

watchReducedMotion((reduced) => {
  env.reducedMotion = reduced;
  document.documentElement.dataset['reducedMotion'] = reduced ? 'true' : 'false';
});
document.documentElement.dataset['reducedMotion'] = env.reducedMotion ? 'true' : 'false';

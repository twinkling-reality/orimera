/**
 * The signed-out surfaces: title screen, Method, and the Atlas you arrive at.
 *
 * THE SHAPE OF THIS FILE IS THE POINT. There is one ground, one top bar and one set of keyboard
 * shortcuts, and they are built once and never rebuilt. Moving between surfaces swaps which pane
 * is shown and which palette the ground holds; it does not navigate, does not unmount the chrome,
 * and does not construct a second version of anything. That is interaction-model.md 1.1 ("there
 * is no scene loading, no 'enter' and no 'return'") honoured at the only place a signed-out page
 * can honour it.
 *
 * NO RENDERER DECISION IS TAKEN HERE. The forbidden-imports contract in
 * `web/.dependency-cruiser.cjs` enforces that this package never names three.js, Spark,
 * PlayCanvas, `@orimera/atlas-three` or `@orimera/atlas-react`.
 */

import '@orimera/presentation/tokens.css';
import './style.css';

import { readEnv, watchReducedMotion } from './env.js';
import {
  MockFormationEventSource,
  initialFormationState,
  reduceFormation,
  replayToEnd,
  withStreamState,
  type FormationState,
  type MockScenario,
} from '@orimera/formation';
import { buildAtlasPane } from './ui/atlas-pane.js';
import { buildChrome, type Surface } from './ui/chrome.js';
import { FIRST_RUN_OFFER, SAMPLE_PLACED, buildCompanion } from './ui/companion.js';
import { buildFormationPanel } from './ui/formation-panel.js';
import { buildMethod } from './ui/method.js';
import { buildFigures, buildTitle } from './ui/title.js';
import { boundaryReason, buildViewportBoundary, readViewport } from './ui/viewport-boundary.js';

const CAPTURE_ID = 'sample-harbour';

const overlay = document.getElementById('overlay');
if (!overlay) throw new Error('landing: expected #overlay in the document');

const env = readEnv();

let unsubscribeSource: (() => void) | null = null;
/** `null` when no capture is forming. The empty Atlas is an empty Atlas. */
let formation: FormationState | null = null;

const panel = buildFormationPanel((scenario) => startFormation(scenario));
const title = buildTitle({ onEnter: () => enter() });
const method = buildMethod();
const atlas = buildAtlasPane(() => go('title'), panel.root);

const chrome = buildChrome({
  onHome: () => go('title'),
  onMethod: () => go('method'),
});

/*
 * The Companion offers the sample; the top bar does not.
 *
 * A "Sample world" destination in the bar was a second way into a second world, which is the
 * discrete-scene structure interaction-model.md 1.1 rejects. The sample is regions placed in THIS
 * Atlas, and the thing that offers to place them is the agent whose whole job is offering things.
 */
const companion = buildCompanion((optionId) => onCompanion(optionId));

// The figures, the bar and the Companion sit outside every pane, shared rather than reproduced.
overlay.append(buildFigures(), chrome.root, title, method, atlas.root, companion.root);

const PANES: Readonly<Record<Surface, HTMLElement>> = {
  title,
  method,
  atlas: atlas.root,
};

let surface: Surface = 'title';
atlas.setArrival('empty');
go('title');
panel.render(formation);

// ---------------------------------------------------------------------------------------------
// Surfaces. Three panes under one bar, never three pages.

/**
 * Show one surface.
 *
 * The ground palette is derived from the surface rather than set alongside it, so there is no
 * state in which the Atlas is showing over a pale ground. `data-surface` on the root is what the
 * stylesheet keys the palette off.
 */
function go(next: Surface): void {
  const previous = surface;
  surface = next;
  document.documentElement.dataset['surface'] = next;
  document.documentElement.dataset['ground'] = next === 'atlas' ? 'deep' : 'pale';
  document.documentElement.dataset['theme'] = next === 'atlas' ? 'blue-hour' : 'dawn';
  chrome.setSurface(next);

  for (const [key, pane] of Object.entries(PANES) as [Surface, HTMLElement][]) {
    pane.hidden = key !== next;
  }

  // Leaving the Atlas ends whatever was forming in it. A stream left running behind a hidden
  // pane would keep describing a capture nobody is looking at.
  if (previous === 'atlas' && next !== 'atlas') {
    stopSource();
    formation = null;
    panel.render(null);
    companion.showTurn(null);
  }
  // The Companion belongs to the world, not to the chrome, so it is not shown over Method.
  companion.root.hidden = next !== 'atlas';

  const shown = PANES[next];
  shown.classList.add('is-faded');
  requestAnimationFrame(() => shown.classList.remove('is-faded'));
  shown.focus({ preventScroll: true });
}

/**
 * The entrance.
 *
 * It always lands in an empty Atlas, because that is what an Atlas with nothing uploaded to it
 * is. The sample is not a different destination; it is something the Companion offers to place
 * here, and the offer is the first thing said on arrival.
 */
function enter(): void {
  go('atlas');
  atlas.setArrival('empty');
  atlas.setArrivalCaption(
    env.reducedMotion
      ? 'You are now in the Atlas. The ground changed without moving, because reduced motion is on.'
      : null,
  );
  // Arriving lands in a genuinely empty Atlas. Nothing forms until it is asked for, because
  // nothing has been uploaded and a console that started counting would be describing an upload
  // that did not happen.
  applyIdle();
  companion.showTurn(FIRST_RUN_OFFER);
}

/**
 * The Companion's one turn on this surface.
 *
 * `later` closes the thread with no penalty and leaves the summon affordance behind, so the
 * dismissal is reversible. An offer you can only decline once is a trap rather than an offer.
 */
function onCompanion(optionId: string): void {
  if (optionId === 'place-sample') {
    placeSampleRegions();
    companion.showTurn(SAMPLE_PLACED);
    return;
  }
  if (optionId === 'summon') {
    companion.showTurn(formation === null ? FIRST_RUN_OFFER : SAMPLE_PLACED);
    return;
  }
  companion.showTurn(null);
}

/** Place the sample regions: a recomposition of this Atlas, not a second world to load. */
function placeSampleRegions(): void {
  atlas.setArrival('populated');
  panel.setOrigin('sample');
  replaySample('ready');
}

// ---------------------------------------------------------------------------------------------
// Formation. One reducer, one set of labels.

function stopSource(): void {
  unsubscribeSource?.();
  unsubscribeSource = null;
}

function applyIdle(): void {
  stopSource();
  formation = null;
  atlas.setArrival('empty');
  panel.setOrigin('yours');
  panel.render(null);
}

function applyFormation(next: FormationState): void {
  formation = next;
  panel.render(formation);
}

/** Subscribe to the MOCK source. The real one is an `EventSource`; see `formation/source.ts`. */
function startFormation(scenario: MockScenario): void {
  stopSource();
  // A scripted replay is a scripted replay however it was reached, so the region is marked from
  // the first frame rather than after it finishes.
  atlas.setArrival('populated');
  panel.setOrigin('sample');
  applyFormation(initialFormationState(CAPTURE_ID));
  const source = new MockFormationEventSource(scenario);
  const resumeFrom = formation === null ? null : formation.lastEventId;
  unsubscribeSource = source.subscribe(
    CAPTURE_ID,
    // Resume from the last event seen, which is null on a fresh run. The real source passes the
    // same token to the server, so reconnect behaviour is exercised by the mock rather than
    // written for the first time against a live stream.
    resumeFrom,
    (event) => {
      if (formation !== null) applyFormation(reduceFormation(formation, event));
    },
    (stream) => {
      if (formation !== null) applyFormation(withStreamState(formation, stream));
    },
  );
}

/** The sample world: the same scripted events, applied with no waiting. */
function replaySample(scenario: MockScenario): void {
  stopSource();
  let state = initialFormationState(CAPTURE_ID);
  replayToEnd(scenario, CAPTURE_ID, (event) => {
    state = reduceFormation(state, event);
  });
  applyFormation(withStreamState(state, 'live'));
}

// ---------------------------------------------------------------------------------------------
// Keyboard. The title screen is a title screen, so it has one.

/**
 * NOTHING HERE BINDS ESCAPE, and nothing ever may: interaction-model.md 2.1 reserves it for
 * releasing the pointer and states plainly that the application can never own it.
 *
 * Two guards keep these from firing on top of something the visitor actually chose. Modified
 * presses are left alone so browser and system shortcuts still work, and while focus sits on a
 * control that control keeps its own keys, so tabbing to GitHub and pressing Enter follows the
 * link instead of starting a session.
 */
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.documentElement.dataset['blocked'] === 'true') return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('button, a, input, textarea, select')) return;

  const follow = (id: string): void => document.getElementById(id)?.click();
  switch (e.key.toLowerCase()) {
    case 'enter':
    case ' ':
      // Only the title screen has a start prompt, so only the title screen answers to it.
      if (surface !== 'title') return;
      e.preventDefault();
      enter();
      return;
    case 'h':
      e.preventDefault();
      go('title');
      return;
    case 'm':
      e.preventDefault();
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

// ---------------------------------------------------------------------------------------------
// Platform.

/*
 * The desktop boundary.
 *
 * Checked on resize as well as at load, because a desktop window can be dragged below the
 * threshold mid-session and a boundary that only ran once would let that through. `apply` runs
 * only when the reason changes, so dragging an edge does not thrash the DOM.
 */
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
/*
 * Resize is not the only way this can change. Attaching a mouse to a tablet flips
 * `(pointer: coarse)` with no resize at all, and a visitor who has just solved the stated problem
 * should not have to reload to be let in.
 */
window.matchMedia('(pointer: coarse)').addEventListener('change', checkViewport);

watchReducedMotion((reduced) => {
  env.reducedMotion = reduced;
  document.documentElement.dataset['reducedMotion'] = reduced ? 'true' : 'false';
});
document.documentElement.dataset['reducedMotion'] = env.reducedMotion ? 'true' : 'false';

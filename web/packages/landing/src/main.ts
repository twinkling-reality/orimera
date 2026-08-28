/**
 * The signed-out landing page, and the entrance into an unformed Atlas.
 *
 * The shape of this file is the point. There is one canvas, created once, never torn down. Moving
 * between the landing composition and the Atlas changes which figure the particle field holds and
 * animates three numbers; it does not unmount anything, does not navigate, and does not construct
 * a renderer. That is interaction-model.md 1.1 ("there is no scene loading, no 'enter' and no
 * 'return'") honoured at the only place a signed-out page can honour it.
 *
 * NO RENDERER DECISION IS TAKEN HERE. ADR-0003 is unresolved, and this page must not prejudge it
 * or pay for it. The forbidden-imports contract in `web/.dependency-cruiser.cjs` enforces that
 * this package never names three.js, Spark, PlayCanvas, `@orimera/atlas-three` or
 * `@orimera/atlas-react`.
 */

import './style.css';

import { Atmosphere } from './atmosphere.js';
import { DPR_CAP, readEnv, watchReducedMotion } from './env.js';
import {
  MockFormationEventSource,
  formationVisual,
  initialFormationState,
  reduceFormation,
  replayToEnd,
  withStreamState,
  type FormationState,
  type MockScenario,
} from './formation/index.js';
import { buildAtlasPane } from './ui/atlas-pane.js';
import { buildFormationPanel } from './ui/formation-panel.js';
import { buildLanding } from './ui/landing.js';

const CAPTURE_ID = 'sample-harbour';

const canvas = document.getElementById('field');
const overlay = document.getElementById('overlay');
if (!(canvas instanceof HTMLCanvasElement) || !overlay) {
  throw new Error('landing: expected #field canvas and #overlay in the document');
}

const env = readEnv();
const atmosphere = new Atmosphere(canvas, env);
atmosphere.start();

let unsubscribeSource: (() => void) | null = null;
/** `null` when no capture is forming. The empty Atlas is an empty Atlas. */
let formation: FormationState | null = null;

const panel = buildFormationPanel((scenario) => startFormation(scenario));
const landing = buildLanding({
  onEnter: () => enter(null),
  onSample: () => enter('ready'),
  onHowItWorks: () => {
    const how = document.getElementById('how-it-works');
    if (how instanceof HTMLDetailsElement) {
      how.open = true;
      how.scrollIntoView({ behavior: env.reducedMotion ? 'auto' : 'smooth', block: 'start' });
      how.querySelector('summary')?.focus();
    }
  },
});
const atlas = buildAtlasPane(() => leave(), panel.root);

overlay.append(landing, atlas.root);
atlas.setArrival('empty');
setView('landing');
paint();

// ---------------------------------------------------------------------------------------------
// Views. Two panes over one canvas, never two pages.

function setView(view: 'landing' | 'atlas'): void {
  document.documentElement.dataset['view'] = view;
  const shown = view === 'landing' ? landing : atlas.root;
  landing.hidden = view !== 'landing';
  atlas.root.hidden = view !== 'atlas';
  // Fade the incoming pane in from the same class the outgoing pane fades out with, so the two
  // halves of the move are one rule rather than two that can drift apart.
  shown.classList.add('is-faded');
  requestAnimationFrame(() => shown.classList.remove('is-faded'));
  // The ground is pale on the landing page and deep inside the Atlas. The canvas lerps between
  // them continuously; the DOM tokens flip at the same moment the pane does, which is behind the
  // fade and therefore never seen mid-change.
  document.documentElement.dataset['ground'] = view === 'landing' ? 'pale' : 'deep';
}

/**
 * The entrance.
 *
 * `scenario` is null for "Enter Orimera", which lands in a genuinely empty Atlas, and set for
 * "Explore a sample world", which lands on an already-formed region. The sample world is replayed
 * through the same reducer as the live path rather than hand-written, so the two cannot diverge.
 */
function enter(scenario: MockScenario | null): void {
  const duration = atmosphere.enterAtlas();
  landing.classList.add('is-faded');

  window.setTimeout(() => {
    setView('atlas');
    atlas.setArrival(scenario === null ? 'empty' : 'sample');
    atlas.setArrivalCaption(
      env.reducedMotion
        ? 'You are now standing in the Atlas. The composition changed without moving, because reduced motion is on.'
        : null,
    );
    atlas.root.focus();
    // "Enter Orimera" arrives in a genuinely empty Atlas. Nothing forms until the visitor asks
    // for it, because nothing has been uploaded and a console that started counting would be
    // describing an upload that did not happen.
    if (scenario === null) applyIdle();
    else replaySample(scenario);
  }, Math.max(0, duration - 260));
}

function leave(): void {
  stopSource();
  formation = null;
  const duration = atmosphere.returnToLanding();
  atlas.root.classList.add('is-faded');
  window.setTimeout(() => {
    setView('landing');
    document.getElementById('path-enter')?.focus();
  }, Math.max(0, duration - 260));
}

// ---------------------------------------------------------------------------------------------
// Formation. One reducer, one visual, one label.

function stopSource(): void {
  unsubscribeSource?.();
  unsubscribeSource = null;
}

function applyIdle(): void {
  formation = null;
  atlas.setArrival('empty');
  atmosphere.setComposition({ kind: 'unformed-atlas' });
  atmosphere.setMotion('breathe');
  panel.render(null);
}

function applyFormation(next: FormationState): void {
  formation = next;
  const visual = formationVisual(formation);
  atmosphere.setComposition({ kind: 'formation', visual });
  atmosphere.setMotion(visual.motion);
  panel.render(formation);
}

/** Subscribe to the MOCK source. The real one is an `EventSource`; see `formation/source.ts`. */
function startFormation(scenario: MockScenario): void {
  stopSource();
  // Whatever the visitor arrived through, a scripted replay is a scripted replay, and the pane
  // says so from the first frame rather than leaving "nothing has been uploaded here" standing
  // above a capture that is visibly forming.
  atlas.setArrival('sample');
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
  atlas.setArrival('sample');
  let state = initialFormationState(CAPTURE_ID);
  replayToEnd(scenario, CAPTURE_ID, (event) => {
    state = reduceFormation(state, event);
  });
  applyFormation(withStreamState(state, 'live'));
}

function paint(): void {
  panel.render(formation);
}


// ---------------------------------------------------------------------------------------------

window.addEventListener('resize', () =>
  atmosphere.resize(Math.min(DPR_CAP, window.devicePixelRatio || 1)),
);

watchReducedMotion((reduced) => {
  env.reducedMotion = reduced;
  atmosphere.setReducedMotion(reduced);
  document.documentElement.dataset['reducedMotion'] = reduced ? 'true' : 'false';
});
document.documentElement.dataset['reducedMotion'] = env.reducedMotion ? 'true' : 'false';

// The field is atmosphere, not information. Nothing is lost by stopping it in a hidden tab, and
// a background tab that keeps a canvas loop alive is a battery cost with no viewer.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) atmosphere.stop();
  else atmosphere.start();
});

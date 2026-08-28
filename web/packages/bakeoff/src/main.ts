import { ATLAS_OVERLAY_CSS, probeCapabilities } from '@orimera/atlas-three';
import type { AtlasRenderer } from '@orimera/atlas-three';
import type { RunConfig, RunResult } from './harness.js';
import { LADDER, labelFor, runOne } from './harness.js';
import { HUD_CSS, Hud } from './hud.js';

/**
 * The bake-off page.
 *
 * URL-DRIVEN, so it can be automated. Every parameter has a default that produces a useful run,
 * and the whole configuration is echoed into the console output so a result can never be read
 * without knowing what produced it.
 *
 *   /?run=ladder                  the whole ladder, 250k to 4M, then a summary line
 *   /?points=1000000              one rung, measured, then handed back to the walker
 *   /?points=4000000&islands=1    the pure single-island rung
 *   /?walk=1&points=1000000       no measurement at all: the "is it a place worth walking in"
 *                                 question, which is a judgement made by looking
 *   &islands=3 &warmup=1500 &measure=6000 &dpr=2 &motes=0 &people=1
 *
 * CONSOLE OUTPUT, parseable and prefixed:
 *   ORIMERA_BAKEOFF_ENV     {...}   capabilities and configuration
 *   ORIMERA_BAKEOFF_ROW     {...}   one per rung
 *   ORIMERA_BAKEOFF_SUMMARY {...}   the whole set, once, at the end
 *
 * `window.orimeraBakeoff` carries the same objects for a driver that would rather read a value
 * than parse a transcript.
 */

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const flag = (key: string, fallback: boolean): boolean => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return raw !== '0' && raw !== 'false';
};

const config: RunConfig = {
  points: num('points', 1_000_000),
  islands: Math.max(1, Math.min(3, num('islands', 3))),
  warmupMs: num('warmup', 1500),
  measureMs: num('measure', 6000),
  pixelRatioCap: num('dpr', 2),
  betweenSpaceMotes: flag('motes', false),
  suppressPeople: flag('people', true),
  quiet: false,
};
const mode = params.get('run') === 'ladder' ? 'ladder' : flag('walk', false) ? 'walk' : 'single';

const style = document.createElement('style');
style.textContent = `html,body{margin:0;height:100%;background:#0b0d12;}${ATLAS_OVERLAY_CSS}${HUD_CSS}`;
document.head.appendChild(style);

const stage = document.getElementById('stage')!;

declare global {
  interface Window {
    orimeraBakeoff?: {
      capabilities: unknown;
      config: RunConfig;
      results: RunResult[];
      done: boolean;
      /** The live renderer, for a driver that wants to pose the camera or flip a setting. */
      renderer: AtlasRenderer | null;
    };
  }
}

async function main(): Promise<void> {
  const capabilities = await probeCapabilities();
  const hud = new Hud(stage, capabilities);
  const results: RunResult[] = [];
  window.orimeraBakeoff = { capabilities, config, results, done: false, renderer: null };

  // ADR-0003 X-R1 step 3: the run must be in visible Chrome with the window in the foreground.
  // Stated on screen and carried in the result, because a number measured in a hidden pane is
  // not a slightly worse number, it is a different measurement.
  const visibleAtStart = document.visibilityState === 'visible';
  const env = {
    capabilities,
    config,
    mode,
    userAgent: navigator.userAgent,
    dpr: devicePixelRatio,
    visibleAtStart,
    viewport: { w: innerWidth, h: innerHeight },
  };
  console.log(`ORIMERA_BAKEOFF_ENV ${JSON.stringify(env)}`);
  if (!visibleAtStart) {
    hud.setPhase(
      'WARNING',
      'page is not visible; requestAnimationFrame is throttled and every fps number here is void',
    );
  }

  if (capabilities.path === 'none') {
    hud.setPhase('failed', 'no WebGL context; nothing to measure');
    return;
  }

  const handles = {
    container: stage,
    onPhase: (phase: string, detail: string) => hud.setPhase(phase, detail),
  };

  let live: AtlasRenderer | null = null;

  const rungs =
    mode === 'ladder'
      ? [...LADDER]
      : [LADDER.includes(config.points as (typeof LADDER)[number]) ? config.points : config.points];

  for (const points of rungs) {
    if (live !== null) {
      // Tear down between rungs so the next one is not measured on top of the previous one's
      // VRAM. There is no way to force a GC from a page, so the heap column between rungs is
      // reported as a peak rather than as a delta, and a rising baseline is expected.
      live.dispose();
      live = null;
      await new Promise((r) => setTimeout(r, 400));
    }

    const runConfig: RunConfig =
      mode === 'walk'
        ? { ...config, points, warmupMs: 0, measureMs: 0, quiet: true }
        : { ...config, points };

    try {
      const { result, renderer } = await runOne(runConfig, capabilities, handles);
      if (mode !== 'walk') results.push(result);
      live = renderer;
      if (window.orimeraBakeoff !== undefined) window.orimeraBakeoff.renderer = renderer;
      hud.render(results);
    } catch (error) {
      console.error(`ORIMERA_BAKEOFF_ERROR ${labelFor(points)}`, error);
      hud.setPhase('failed', `${labelFor(points)}: ${String(error)}`);
      break;
    }
  }

  const summary = {
      env,
      results,
      // Restated on the summary so a copied result set carries its own caveats.
      caveats: [
        'graphicsPath is webgl2: Spark 2.1.0 requires THREE.WebGLRenderer, so option A forecloses WebGPU.',
        'uploadedBytes is a lower bound on VRAM. No browser API reports GPU memory.',
        'heap figures are Chrome-only, quantised, and exclude GPU allocations.',
        'a row with spoiled=true contained a period where the page was not visible.',
      ],
  };
  console.log(`ORIMERA_BAKEOFF_SUMMARY ${JSON.stringify(summary)}`);

  // Post the summary back to the dev server, so a run in a real foreground Chrome window (the
  // only run whose numbers are valid) can still be collected without reading that window's
  // console. Failure is logged and ignored: a build with no sink is still a usable page.
  if (flag('post', mode === 'ladder') && results.length > 0) {
    try {
      await fetch('/__bakeoff/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summary),
      });
    } catch (error) {
      console.warn('ORIMERA_BAKEOFF_POST_FAILED', error);
    }
  }
  if (window.orimeraBakeoff !== undefined) window.orimeraBakeoff.done = true;

  // Hand the world back to the walker. The scene is never reloaded: the same graph the
  // measurement ran against is the one the user now walks, which is the whole point of there
  // being exactly one scene for the session.
  if (live !== null) {
    const renderer = live;
    renderer.scriptedPose = null;
    renderer.placeWalkerAtViewpoint(renderer.islandViews.values().next().value!.island);
    renderer.start();
    let last = performance.now();
    let frames = 0;
    const tick = (): void => {
      frames += 1;
      const now = performance.now();
      if (now - last > 500) {
        hud.setLive(
          (frames * 1000) / (now - last),
          renderer.uploadedBytes() / 18,
          'WASD to move, click to look',
        );
        frames = 0;
        last = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

void main();

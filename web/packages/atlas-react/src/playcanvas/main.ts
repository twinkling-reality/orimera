import type { BakeoffResult } from './harness.js';
import { parseConfig, runBakeoff } from './harness.js';

/**
 * Entry point for `playcanvas-bakeoff.html`.
 *
 * Deliberately thin. Everything measurable is in `harness.ts` so that a headless driver can call
 * `runBakeoff` directly without going through a page, and so that the page cannot accidentally
 * become part of the measurement.
 */

declare global {
  // eslint-disable-next-line no-var
  var __orimeraBakeoff: Promise<BakeoffResult> | undefined;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('atlas') as HTMLCanvasElement | null;
  const stage = document.getElementById('stage');
  const readout = document.getElementById('readout');
  if (canvas === null || stage === null) throw new Error('page is missing #atlas or #stage');

  const config = parseConfig(location.search);
  if (!config.autorun) {
    if (readout !== null) readout.textContent = 'autorun=0. Call window.__orimeraStart().';
    (globalThis as unknown as { __orimeraStart: () => void }).__orimeraStart = () => {
      void start();
    };
    return;
  }
  await start();

  async function start(): Promise<void> {
    if (readout !== null) {
      readout.textContent = `loading ${config.points.toLocaleString()} points x ${config.islands}`;
    }
    const handle = await runBakeoff(canvas!, stage!, config);
    globalThis.__orimeraBakeoff = handle.result;
    // Live handle for inspection from a console or a driver. Not part of the measured path.
    (globalThis as unknown as { __orimera: unknown }).__orimera = handle;
    const result = await handle.result;
    if (readout !== null) {
      readout.textContent =
        `${result.device} · ${result.scenePoints.toLocaleString()} pts · ` +
        `${result.fpsMean} fps mean · ${result.fpsP1Low} fps 1% low · ` +
        `${result.gpuUploadedMB} MB uploaded · tfmr ${Math.round(result.tfmrMs)} ms`;
    }
    // A stable hook for a driver that scrapes the DOM rather than the console.
    document.body.dataset['bakeoffDone'] = '1';
  }
}

void main().catch((error: unknown) => {
  console.log(
    `ORIMERA-BAKEOFF ${JSON.stringify({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })}`,
  );
  const readout = document.getElementById('readout');
  if (readout !== null) {
    readout.textContent = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  document.body.dataset['bakeoffDone'] = 'error';
});

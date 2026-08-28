import * as pc from 'playcanvas';
import type { AtlasScene, Island, IslandId } from '@orimera/atlas-core';
import { makeIsland, makeScene } from '@orimera/atlas-core';
import { AtlasBinding } from './atlas-binding.js';
import type { PointMap } from './opm.js';
import { decodeOpm } from './opm.js';
import { probeAll } from './probes.js';

/**
 * THE BAKE-OFF HARNESS.
 *
 * ADR-0003 is settled by a measurement, not an argument, and a measurement is only a measurement
 * if the two engines are asked the identical question. Everything below is therefore specified
 * rather than chosen at runtime: the URL parameters, the deterministic camera path, the metric
 * definitions and the console record format are the CONTRACT the three.js binding must match
 * byte for byte in its output shape.
 *
 * -------------------------------------------------------------------------------------------
 * URL PARAMETERS
 * -------------------------------------------------------------------------------------------
 *   points    250000 | 1000000 | 2000000 | 3000000 | 4000000   points PER ISLAND (default 1000000)
 *   islands   1..8                                             independently transformed islands (default 1)
 *   device    webgl2 | webgpu                                  (default webgl2)
 *   warmup    seconds discarded before measuring               (default 3)
 *   measure   seconds of measurement                           (default 15)
 *   width     canvas CSS width                                 (default 1600)
 *   height    canvas CSS height                                (default 900)
 *   dpr       device pixel ratio override, 1..3                (default window.devicePixelRatio)
 *   overlay   1 | 0    anchor overlay + focus solver live      (default 1)
 *   path      orbit | static                                   (default orbit)
 *   blend     1 | 0    alpha blending instead of alpha test    (default 0)
 *   size      point sprite world size in metres                (default 0.05)
 *   fov       vertical field of view in degrees                (default 70)
 *   fixtures  base URL for the .opm files                      (default /)
 *   autorun   1 | 0                                            (default 1)
 *   driver    raf | timer                                      (default raf)
 *
 * `driver=raf` is the real metric and REQUIRES a visible, foreground window: Chrome suspends
 * requestAnimationFrame in an occluded tab, so a background run collects zero frames. `timer`
 * drives update and render from a timer and blocks on the GPU each frame, which works in a hidden
 * tab and in CI but measures frame COST rather than presented frame RATE. They are not
 * interchangeable and the driver is recorded in every result.
 *
 * SCENE POINT TOTAL IS `points * islands`, and it is reported explicitly, so a 3-island run at
 * 1M reports 3,000,000 and is directly comparable to a 1-island run at 3M.
 *
 * -------------------------------------------------------------------------------------------
 * CONSOLE OUTPUT
 * -------------------------------------------------------------------------------------------
 * Every record is one line, `ORIMERA-BAKEOFF ` followed by JSON, so a shell can grep and a script
 * can `JSON.parse` the remainder. Record kinds, in emission order:
 *
 *   config  the resolved parameters plus the real device and driver
 *   load    bytes, fetch ms, decode ms, upload ms, and whether the loader had to repack
 *   tfmr    time to first meaningful render, in ms from harness start
 *   claim   one per ADR-0003 claim probed against the running engine
 *   result  the measurement
 *   error   anything that stopped the run
 *
 * `window.__orimeraBakeoff` resolves to the `result` record, for driving from automation.
 *
 * -------------------------------------------------------------------------------------------
 * METRIC DEFINITIONS. Both bindings must use these, or the numbers are not comparable.
 * -------------------------------------------------------------------------------------------
 *   frame time   the interval between consecutive requestAnimationFrame callbacks, unclamped.
 *                Not the render call's own duration: what the user feels is the interval.
 *   fps mean     1000 / (mean frame time).
 *   fps p1low    1000 / (99th percentile frame time). The number that decides whether it stutters.
 *   heapMB       performance.memory.usedJSHeapSize, Chrome only, sampled at the end of the run.
 *   gpuMB        the ENGINE's own VRAM accounting (vertex + index + texture bytes it uploaded).
 *                Neither WebGL2 nor WebGPU exposes a real driver allocation figure, so this is a
 *                lower bound on what was uploaded and is labelled as such, never as "GPU memory".
 *   tfmrMs       from harness start to the end of the first frame in which every island's point
 *                cloud is resident and has been drawn at full count.
 */

const BAKEOFF_PREFIX = 'ORIMERA-BAKEOFF';

export type PathMode = 'orbit' | 'static';

export interface HarnessConfig {
  readonly points: number;
  readonly islands: number;
  readonly device: 'webgl2' | 'webgpu';
  readonly warmupSeconds: number;
  readonly measureSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly overlay: boolean;
  readonly path: PathMode;
  readonly blend: boolean;
  readonly sizeGain: number;
  readonly fov: number;
  readonly fixtures: string;
  readonly autorun: boolean;
  /** How frames are driven. See the note above the timer loop; they are different metrics. */
  readonly driver: 'raf' | 'timer';
}

function intParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function floatParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boolParam(params: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function parseConfig(search: string): HarnessConfig {
  const p = new URLSearchParams(search);
  const device = p.get('device') === 'webgpu' ? 'webgpu' : 'webgl2';
  const path: PathMode = p.get('path') === 'static' ? 'static' : 'orbit';
  return {
    points: intParam(p, 'points', 1_000_000),
    islands: Math.max(1, Math.min(8, intParam(p, 'islands', 1))),
    device,
    warmupSeconds: floatParam(p, 'warmup', 3),
    measureSeconds: floatParam(p, 'measure', 15),
    width: intParam(p, 'width', 1600),
    height: intParam(p, 'height', 900),
    dpr: Math.max(1, Math.min(3, floatParam(p, 'dpr', globalThis.devicePixelRatio || 1))),
    overlay: boolParam(p, 'overlay', true),
    path,
    blend: boolParam(p, 'blend', false),
    sizeGain: floatParam(p, 'size', 0.05),
    fov: floatParam(p, 'fov', 70),
    fixtures: p.get('fixtures') ?? '/',
    autorun: boolParam(p, 'autorun', true),
    driver: p.get('driver') === 'timer' ? 'timer' : 'raf',
  };
}

/** The ladder. A run at a count outside it is legal but is flagged, because it is not comparable. */
export const POINT_LADDER = [250_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000] as const;

export function fixtureName(points: number): string {
  const label = points >= 1_000_000 ? `${points / 1_000_000}M` : `${Math.round(points / 1000)}k`;
  return `harbour-${label}.opm`;
}

export interface BakeoffResult {
  readonly kind: 'result';
  readonly engine: 'playcanvas';
  readonly engineVersion: string;
  readonly device: string;
  readonly gpu: string;
  readonly pointsPerIsland: number;
  readonly islands: number;
  readonly scenePoints: number;
  readonly drawCalls: number;
  readonly frames: number;
  readonly fpsMean: number;
  readonly fpsP1Low: number;
  readonly frameMeanMs: number;
  readonly frameP50Ms: number;
  readonly frameP95Ms: number;
  readonly frameP99Ms: number;
  readonly heapMB: number | null;
  readonly gpuUploadedMB: number;
  readonly tfmrMs: number;
  readonly overlay: boolean;
  readonly overlayNodes: number;
  readonly canvasPixels: number;
  readonly dpr: number;
  /** True if the tab was ever hidden during the run. A true here invalidates the numbers. */
  readonly documentHidden: boolean;
  readonly driver: 'raf' | 'timer';
  /**
   * False when the run produced no visible geometry, or when the GPU raised a validation error.
   *
   * A result with `renderValid: false` is not a slow result, it is a WRONG one, and it will
   * usually look like the FASTEST result in the table. See the guard below.
   */
  readonly renderValid: boolean;
  /**
   * Cost of a frame with every island's geometry switched off, in ms. `timer` driver only.
   *
   * This is the FLOOR the environment imposes: clear, overlay, present and the GPU sync. If it is
   * close to `frameMeanMs`, the run did not measure the point cloud at all, it measured a cap.
   */
  readonly emptyFrameMs: number | null;
  /** True when the empty-scene floor accounts for most of the measured frame time. */
  readonly throttleSuspected: boolean;
  /** Non-background pixels found in the sample grid. WebGL2 only; null on WebGPU. */
  readonly sampledPixels: number | null;
  readonly gpuErrors: readonly string[];
  readonly notes: readonly string[];
}

function emit(kind: string, payload: Record<string, unknown>): void {
  // One line, prefix, JSON. Parseable by both a human and a script, which is the whole point.
  console.log(`${BAKEOFF_PREFIX} ${JSON.stringify({ kind, ...payload })}`);
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx]!;
}

function rendererString(device: pc.GraphicsDevice): string {
  const gl = (device as unknown as { gl?: WebGL2RenderingContext }).gl;
  if (gl !== undefined) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext !== null) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    return String(gl.getParameter(gl.RENDERER));
  }
  const adapter = (device as unknown as { gpuAdapter?: { info?: { description?: string } } })
    .gpuAdapter;
  return adapter?.info?.description ?? 'webgpu adapter (description not exposed)';
}

/**
 * Build the scene.
 *
 * The island fixture from `scene-synth` is loaded when present, because it carries the anchors
 * that span the four epistemic states the overlay has to distinguish. When it is absent, or when
 * more islands are requested than the fixture has, islands are cloned onto a ring. Cloning is
 * layout-only: it never invents anchors, so the overlay load stays honest.
 */
async function loadScene(config: HarnessConfig): Promise<AtlasScene> {
  const url = new URL('harbour-scene.json', new URL(config.fixtures, location.href));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`scene fixture ${url.pathname}: ${response.status}`);
  const json = (await response.json()) as {
    layoutVersion: number;
    stateVersion: number;
    islands: Array<Record<string, unknown> & { layoutEntities: string[] }>;
  };

  // atlas-core's branded types erase completely at runtime, so this cast is sound. The one
  // exception is layoutEntities, which is a Set and serialises as an array.
  const all = json.islands.map((raw) =>
    makeIsland({
      ...(raw as unknown as Island),
      layoutEntities: new Set(raw.layoutEntities) as unknown as Island['layoutEntities'],
    }),
  );

  const picked: Island[] = [];
  for (let i = 0; i < config.islands; i += 1) {
    const source = all[i % all.length];
    if (source === undefined) throw new Error('scene fixture contains no islands');
    if (i < all.length) {
      picked.push(source);
      continue;
    }
    // A cloned island needs a distinct id, or `buildAnchorTable` rejects the duplicate anchors,
    // which is the table doing its job.
    const suffix = `-clone${i}`;
    const angle = (i / config.islands) * Math.PI * 2;
    const radius = 260;
    picked.push(
      makeIsland({
        ...source,
        islandId: `${source.islandId}${suffix}` as IslandId,
        createdAt: source.createdAt + i,
        placement: {
          position: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius },
          yaw: angle,
          scale: 1,
        } as Island['placement'],
        anchors: source.anchors.map((a) => ({
          ...a,
          anchorId: `${a.anchorId}${suffix}` as typeof a.anchorId,
          islandId: `${source.islandId}${suffix}` as IslandId,
        })),
      }),
    );
  }

  return makeScene(picked, json.layoutVersion, json.stateVersion);
}

export interface HarnessHandle {
  readonly config: HarnessConfig;
  readonly binding: AtlasBinding;
  readonly result: Promise<BakeoffResult>;
}

export async function runBakeoff(
  canvas: HTMLCanvasElement,
  overlayParent: HTMLElement,
  config: HarnessConfig,
): Promise<HarnessHandle> {
  const t0 = performance.now();
  const notes: string[] = [];

  if (!POINT_LADDER.includes(config.points as (typeof POINT_LADDER)[number])) {
    notes.push(`points=${config.points} is off the comparison ladder`);
  }

  canvas.style.width = `${config.width}px`;
  canvas.style.height = `${config.height}px`;
  canvas.width = Math.round(config.width * config.dpr);
  canvas.height = Math.round(config.height * config.dpr);

  emit('config', { engine: 'playcanvas', engineVersion: pc.version, ...config });

  // ---- load ---------------------------------------------------------------------------------
  const fixtureUrl = new URL(fixtureName(config.points), new URL(config.fixtures, location.href));
  const fetchStart = performance.now();
  const response = await fetch(fixtureUrl);
  if (!response.ok) throw new Error(`fixture ${fixtureUrl.pathname}: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const fetchMs = performance.now() - fetchStart;

  const decodeStart = performance.now();
  const map: PointMap = decodeOpm(bytes);
  const decodeMs = performance.now() - decodeStart;

  if (!map.planarContiguous) {
    notes.push(
      'the .opm sections were not contiguous, so the loader repacked 18 bytes per point on the ' +
        'CPU before upload; this cost is inside uploadMs',
    );
  }

  const scene = await loadScene(config);

  // Every island shares the same point map, which is what "N independently transformed islands"
  // means: one source shell, N placements. Each island still gets its OWN vertex buffer, so the
  // uploaded-bytes figure reflects N copies resident on the GPU rather than one.
  const pointMaps = new Map<IslandId, PointMap>();
  for (const island of scene.islands) pointMaps.set(island.islandId, map);

  const uploadStart = performance.now();
  const binding = await AtlasBinding.create({
    canvas,
    overlayParent,
    scene,
    pointMaps,
    deviceTypes: [config.device],
    blend: config.blend,
    sizeGain: config.sizeGain,
    fov: config.fov,
    overlay: config.overlay,
  });
  const uploadMs = performance.now() - uploadStart;

  const actualDevice = binding.device.isWebGPU ? 'webgpu' : 'webgl2';
  if (actualDevice !== config.device) {
    notes.push(`requested ${config.device}, got ${actualDevice}`);
  }
  if (actualDevice === 'webgpu') {
    notes.push(
      'WebGPU point-list has no point size: every point rasterises to one pixel. ' +
        'The image is not comparable to the WebGL2 one, only the throughput is.',
    );
  }

  emit('load', {
    file: fixtureUrl.pathname,
    bytes: bytes.byteLength,
    pointsPerIsland: map.header.pointCount,
    fetchMs: Math.round(fetchMs * 100) / 100,
    decodeMs: Math.round(decodeMs * 100) / 100,
    uploadMs: Math.round(uploadMs * 100) / 100,
    repacked: binding.islands.some((i) => i.cloud.repacked),
    vertexBytesPerIsland: binding.islands[0]?.cloud.vertexBytes ?? 0,
  });

  for (const check of binding.verifyPlacements()) {
    if (check.maxErrorMetres > 1e-3) {
      notes.push(
        `placement mismatch on ${check.islandId}: engine transform differs from localToAtlas by ${check.maxErrorMetres.toFixed(4)} m`,
      );
    }
  }

  const layer = binding.app.scene.layers.getLayerById(pc.LAYERID_WORLD);
  for (const claim of probeAll(binding.app, layer, binding.islands.length)) {
    emit('claim', { ...claim });
  }

  // ---- the render-validity guard ------------------------------------------------------------
  //
  // THIS EXISTS BECAUSE A BROKEN RENDERER IS THE FASTEST RENDERER.
  //
  // Measured on 2.21.4: a WGSL shader that fails to parse is rejected by the WebGPU pipeline, and
  // in the RELEASE engine build that rejection is silent. `WebgpuDebug.validate` and the shader
  // error reporting are debug-only, so the application sees a shader marked ready, a draw call
  // issued every frame, and a blank canvas. The harness happily reported 1100 fps at 1M points
  // against a scene that drew nothing at all, which is exactly the kind of number that decides an
  // ADR the wrong way.
  //
  // Two cheap checks close it. Neither is engine-specific and the three.js binding should carry
  // the same pair.
  /**
   * Non-background pixels in the whole framebuffer, counted ONCE and only after the last measured
   * frame. WebGL2 only: reading the WebGPU swap-chain back needs a copyTextureToBuffer round trip,
   * and the uncaptured-error hook already covers the failure mode that matters there.
   *
   * TWO CONSTRAINTS, BOTH LEARNED THE HARD WAY.
   *
   * It must not run before or during the measurement. A `readPixels` against the default
   * framebuffer forces a resolve on the ANGLE Metal backend, and sampling on the first frame
   * measurably slowed every frame after it: the same 1M configuration read 17 ms before the check
   * existed and 63 ms after. A validity check that changes the number it validates is worse than
   * no check. After the final frame the cost is free, which is why this reads everything.
   *
   * It must not sample a sub-region. A centre patch was empty on a legitimate orbit pose where
   * both islands sat off-axis, and marked a good run invalid.
   */
  const gpuErrors: string[] = [];
  let sampledPixels: number | null = null;
  let pendingFinish = false;
  let emptyFrameMs: number | null = null;

  /**
   * A frame that costs the same with the geometry switched off did not measure the geometry.
   *
   * Observed on this machine: a backgrounded Chrome tab keeps executing explicit draw calls but
   * rate-limits them, and every configuration from 250k to 4M points then reports the identical
   * frame time. Without this check the harness reports that number as a result, and the ladder
   * comes out flat, which reads as "the renderer scales perfectly" rather than "nothing was
   * measured". Not a subtle failure to have in an ADR.
   */
  const throttleSuspected = (meanMs: number): boolean =>
    emptyFrameMs !== null && meanMs > 0 && emptyFrameMs > meanMs * 0.75;

  const wgpuDevice = (
    binding.device as unknown as {
      wgpu?: {
        addEventListener?: (t: string, h: (e: { error?: { message?: string } }) => void) => void;
      };
    }
  ).wgpu;
  wgpuDevice?.addEventListener?.('uncapturederror', (event) => {
    const message = event.error?.message ?? 'unknown GPU validation error';
    if (gpuErrors.length < 4) gpuErrors.push(message);
  });

  /**
   * Count non-background pixels in a patch at screen centre. WebGL2 only: reading the WebGPU
   * swap-chain back needs a copyTextureToBuffer round trip, and the uncaptured-error hook already
   * covers the failure mode that matters there.
   *
   * TWO CONSTRAINTS, AND BOTH WERE LEARNED THE HARD WAY.
   *
   * It runs ONCE, and it runs on the LAST frame of the measurement rather than the first. A
   * `readPixels` against the default framebuffer forces a resolve on the ANGLE Metal backend, and
   * doing it early measurably slowed every subsequent frame: the same 1M configuration read 17 ms
   * before the check was added and 63 ms after, purely from one readback at the start. A
   * validity check that changes the number it is validating is worse than no check.
   *
   * It samples a bounded patch rather than a full-width strip, for the same reason.
   */
  const samplePixels = (): void => {
    const gl = (binding.device as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (gl === undefined) return;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // The clear colour, quantised. Anything meaningfully brighter is drawn content.
    let count = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i]! > 22 || buf[i + 1]! > 24 || buf[i + 2]! > 30) count += 1;
    }
    sampledPixels = count;
  };

  // ---- measure ------------------------------------------------------------------------------
  const frameTimes: number[] = [];
  let tfmrMs = 0;
  let elapsed = 0;
  let firstDrawn = false;
  let resolveResult!: (r: BakeoffResult) => void;
  const result = new Promise<BakeoffResult>((resolve) => {
    resolveResult = resolve;
  });

  const start = binding.controls.state;
  const centre = { x: start.x, z: start.z };
  const orbitRadius = 26;

  binding.app.on('update', (dt: number) => {
    elapsed += dt;
    if (config.path === 'orbit') {
      // Deterministic in ELAPSED TIME, not in frame count, so a slower engine visits the same
      // poses as a faster one and the two are looking at the same thing when compared.
      const a = elapsed * 0.22;
      binding.controls.state.x = centre.x + Math.cos(a) * orbitRadius;
      binding.controls.state.z = centre.z + Math.sin(a) * orbitRadius;
      binding.controls.state.yaw = -a + Math.PI / 2;
      binding.controls.state.pitch = Math.sin(elapsed * 0.11) * 0.16;
    }
    binding.update(dt, performance.now());
  });

  // THE WINDOWS ARE COUNTED IN RENDERED FRAME TIME, NOT WALL CLOCK, AND THAT IS DELIBERATE.
  //
  // A hidden or occluded tab suspends requestAnimationFrame outright while setTimeout keeps
  // running, so a wall-clock window can close having collected zero frames and still report a
  // number. That failure is silent and it is exactly the failure ADR-0003 warns about when it
  // insists the bake-off run "in visible Chrome with the window in the foreground". Accumulating
  // the windows from the frame intervals themselves makes the run impossible to complete without
  // real frames, and `documentHidden` records it if the tab was ever backgrounded anyway.
  let warmupAccum = 0;
  let measureAccum = 0;
  let hiddenDuringRun = typeof document !== 'undefined' && document.hidden;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenDuringRun = true;
    });
  }

  binding.app.on('frameupdate', (ms: number) => {
    if (config.driver !== 'raf') return;
    if (!firstDrawn) return;
    if (warmupAccum < config.warmupSeconds * 1000) {
      warmupAccum += ms;
      return;
    }
    if (measureAccum >= config.measureSeconds * 1000) return;
    measureAccum += ms;
    frameTimes.push(ms);
    // The pixel sample runs on the NEXT frameend, so the readback lands after the last measured
    // frame rather than inside the window it is validating.
    if (measureAccum >= config.measureSeconds * 1000) pendingFinish = true;
  });

  binding.app.on('frameend', () => {
    if (!firstDrawn) {
      firstDrawn = true;
      tfmrMs = performance.now() - t0;
      emit('tfmr', { tfmrMs: Math.round(tfmrMs * 100) / 100 });
      elapsed = 0;
    }
    if (pendingFinish) {
      pendingFinish = false;
      samplePixels();
      resolveResult(finish());
    }
  });

  /**
   * THE `timer` DRIVER, AND WHY IT EXISTS.
   *
   * `raf` is the metric that matters for the product: the interval between animation frames is
   * what a user feels, and it includes vsync and the compositor. It is also the metric that
   * CANNOT BE COLLECTED AT ALL unless the window is genuinely visible and in the foreground,
   * because Chrome suspends requestAnimationFrame in an occluded or backgrounded tab. That is
   * exactly the failure ADR-0003 warns about, and a headless or remote-controlled browser hits it
   * every time.
   *
   * `timer` drives update and render from a timer instead, and blocks on the GPU after each
   * frame, so it measures the cost of producing one frame rather than the rate at which frames
   * are presented. It runs in a hidden tab and in CI. The two numbers are NOT interchangeable:
   * a `timer` run is uncapped by vsync and excludes present, so it reads high against a 60 Hz
   * `raf` run and low against a run that is compositor-bound. `driver` is recorded in the result
   * so a comparison across drivers is visible rather than accidental.
   *
   * The GPU block is a one-pixel readPixels on WebGL2 and `queue.onSubmittedWorkDone()` on
   * WebGPU. Without it the timings measure command submission, not work.
   *
   * Scheduling is a MessageChannel rather than setTimeout, because Chrome clamps timers in a
   * hidden tab to roughly one per second. That clamp does not corrupt the metric, since each
   * sample is the duration of one step rather than the interval between steps, but it makes a
   * run take minutes instead of seconds. MessageChannel is not clamped.
   */
  if (config.driver === 'timer') {
    binding.app.autoRender = false;
    const gl = (binding.device as unknown as { gl?: WebGL2RenderingContext }).gl;
    const pixel = new Uint8Array(4);
    // Typed structurally rather than via @webgpu/types: one method is all this needs.
    const wgpu = (
      binding.device as unknown as {
        wgpu?: { queue: { onSubmittedWorkDone: () => Promise<void> } };
      }
    ).wgpu;

    const syncGpu = async (): Promise<void> => {
      if (gl !== undefined) {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return;
      }
      await wgpu?.queue.onSubmittedWorkDone();
    };

    /**
     * Ten frames with every island's render component disabled, so the floor is measured against
     * the same canvas, the same overlay and the same GPU sync as the real run.
     */
    const measureEmptyFrame = async (): Promise<number> => {
      for (const visual of binding.islands) {
        if (visual.entity.render) visual.entity.render.enabled = false;
      }
      const samples: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const t = performance.now();
        binding.app.update(1 / 60);
        binding.app.render();
        await syncGpu();
        if (i >= 2) samples.push(performance.now() - t);
      }
      for (const visual of binding.islands) {
        if (visual.entity.render) visual.entity.render.enabled = true;
      }
      return samples.reduce((a, b) => a + b, 0) / Math.max(samples.length, 1);
    };

    const step = async (): Promise<void> => {
      const frameStart = performance.now();
      binding.app.update(1 / 60);
      binding.app.render();
      await syncGpu();
      const ms = performance.now() - frameStart;

      if (!firstDrawn) {
        firstDrawn = true;
        tfmrMs = performance.now() - t0;
        emit('tfmr', { tfmrMs: Math.round(tfmrMs * 100) / 100 });
        elapsed = 0;
      } else if (warmupAccum < config.warmupSeconds * 1000) {
        warmupAccum += ms;
        if (warmupAccum >= config.warmupSeconds * 1000 && emptyFrameMs === null) {
          emptyFrameMs = await measureEmptyFrame();
        }
      } else if (measureAccum < config.measureSeconds * 1000) {
        measureAccum += ms;
        frameTimes.push(ms);
      }

      if (measureAccum >= config.measureSeconds * 1000) {
        // Sampled here, after the final measured frame and after its GPU sync, so the readback
        // cannot slow down anything that was measured.
        samplePixels();
        resolveResult(finish());
        return;
      }
      schedule();
    };

    const channel = new MessageChannel();
    const schedule = (): void => channel.port2.postMessage(0);
    channel.port1.onmessage = (): void => void step();
    schedule();
  }

  function finish(): BakeoffResult {
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(sorted.length, 1);

    if (gpuErrors.length > 0) {
      notes.push(
        `the GPU raised ${gpuErrors.length} validation error(s); the scene did not render and ` +
          `these timings are meaningless: ${gpuErrors[0] ?? ''}`,
      );
    }
    if (sampledPixels === 0) {
      notes.push(
        'the framebuffer contained no drawn pixels on the last measured frame: the scene ' +
          'rendered nothing, so these timings are meaningless',
      );
    }
    if (throttleSuspected(mean)) {
      notes.push(
        `an empty scene costs ${(emptyFrameMs ?? 0).toFixed(1)} ms in this environment, which is ` +
          'most of the measured frame time: the run hit an environment cap rather than the ' +
          'renderer, and these timings say nothing about the point cloud',
      );
    }
    if (hiddenDuringRun) {
      notes.push(
        'the tab was hidden or occluded: a background tab both suspends requestAnimationFrame ' +
          'and rate-limits explicit draws, so no measurement taken here is trustworthy',
      );
    }
    if (config.driver === 'timer') {
      notes.push(
        'driver=timer measures frame cost with a GPU sync per frame, not presented frame rate; ' +
          'it is uncapped by vsync and excludes compositing, so it is only comparable to another ' +
          'driver=timer run',
      );
    }
    const vram = binding.app.stats.vram;
    const uploaded = (vram.vb + vram.ib + vram.tex) / (1024 * 1024);
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const counts = binding.overlay?.counts;

    const record: BakeoffResult = {
      kind: 'result',
      engine: 'playcanvas',
      engineVersion: pc.version,
      device: actualDevice,
      gpu: rendererString(binding.device),
      pointsPerIsland: map.header.pointCount,
      islands: binding.islands.length,
      scenePoints: map.header.pointCount * binding.islands.length,
      drawCalls: binding.islands.length,
      frames: sorted.length,
      fpsMean: Math.round((1000 / Math.max(mean, 1e-6)) * 10) / 10,
      fpsP1Low: Math.round((1000 / Math.max(percentile(sorted, 0.99), 1e-6)) * 10) / 10,
      frameMeanMs: Math.round(mean * 100) / 100,
      frameP50Ms: Math.round(percentile(sorted, 0.5) * 100) / 100,
      frameP95Ms: Math.round(percentile(sorted, 0.95) * 100) / 100,
      frameP99Ms: Math.round(percentile(sorted, 0.99) * 100) / 100,
      heapMB:
        memory === undefined ? null : Math.round((memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10,
      gpuUploadedMB: Math.round(uploaded * 10) / 10,
      tfmrMs: Math.round(tfmrMs * 100) / 100,
      overlay: config.overlay,
      overlayNodes:
        counts === undefined
          ? 0
          : counts.focusLabels + counts.callouts + counts.chevrons + counts.presenceMarkers,
      canvasPixels: canvas.width * canvas.height,
      dpr: config.dpr,
      documentHidden: hiddenDuringRun,
      driver: config.driver,
      renderValid:
        gpuErrors.length === 0 &&
        (sampledPixels === null || sampledPixels > 0) &&
        !throttleSuspected(mean),
      emptyFrameMs: emptyFrameMs === null ? null : Math.round(emptyFrameMs * 100) / 100,
      throttleSuspected: throttleSuspected(mean),
      sampledPixels,
      gpuErrors: [...gpuErrors],
      notes,
    };
    emit('result', record as unknown as Record<string, unknown>);
    return record;
  }

  binding.app.start();

  return { config, binding, result };
}

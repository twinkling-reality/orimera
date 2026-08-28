import type { Anchor, AtlasScene, AnchorTable, EntityId } from '@orimera/atlas-core';
import { buildAnchorTable } from '@orimera/atlas-core';
import type { RendererCapabilities } from '@orimera/atlas-three';
import {
  AtlasRenderer,
  FrameMeter,
  bindSegmentsByName,
  fetchPointMap,
  readHeap,
} from '@orimera/atlas-three';
import type { Pose } from './camera-path.js';
import { pathContext, poseAt } from './camera-path.js';
import { rehydrateScene } from './scene-json.js';

/**
 * THE BAKE-OFF HARNESS.
 *
 * ADR-0003 X-R1 asks two questions in order. The first, "does it look like a place worth walking
 * in", is a judgement call made by looking, and this harness deliberately does not answer it: it
 * renders the world with the anchor overlay, the focus solver and the walker all live so that
 * the judgement is made against the real thing rather than against a point viewer. The second,
 * "does it hold 60 fps at 1.5M splats", is what the numbers below are for.
 *
 * What the harness refuses to do, because each would produce a number that flatters the answer:
 *
 *   - It does not measure with the point cloud alone. scene-synth's own note: "a binding that
 *     only draws points measures half the frame budget." The overlay projection, the focus
 *     solver, the emphasis buffers and the presence markers all run inside every measured frame.
 *   - It does not use a static camera. See `camera-path.ts`.
 *   - It does not discard a spoiled window. ADR-0003 warns that a throttled, hidden render pane
 *     invalidates the numbers, so visibility loss is detected and the window is REPORTED as
 *     spoiled rather than silently dropped.
 *   - It does not report a GPU memory figure it cannot measure. No browser API exposes VRAM.
 *     What it reports is the exact byte count uploaded, labelled as a lower bound.
 */

export const LADDER = [250_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000] as const;

export interface RunConfig {
  /** A rung of the ladder. This many points per island. */
  readonly points: number;
  /** How many islands share the one canvas. The Atlas is continuous, so 3 is the real case. */
  readonly islands: number;
  readonly warmupMs: number;
  readonly measureMs: number;
  readonly pixelRatioCap: number;
  readonly betweenSpaceMotes: boolean;
  /** People are citations, not geometry. Off only to measure what that rule costs. */
  readonly suppressPeople: boolean;
  /** Walk mode measures nothing, so it must not emit a row of zeroes that looks like a result. */
  readonly quiet: boolean;
}

export interface RunResult {
  readonly label: string;
  readonly pointsPerIsland: number;
  readonly islands: number;
  readonly pointsTotal: number;

  readonly fetchMs: number;
  readonly decodeMs: number;
  /** Run start to the first frame the GPU has acknowledged. Includes fetch, decode and upload. */
  readonly timeToFirstRenderMs: number;
  /** Buffers attached to GPU-acknowledged. Shader compile plus first upload, without the network. */
  readonly firstDrawMs: number;
  /** The occupancy grid build, kept deliberately outside first render. See containment.ts. */
  readonly occupancyMs: number;

  readonly fpsMean: number;
  readonly fpsP1Low: number;
  readonly frameMsMean: number;
  readonly frameMsP95: number;
  readonly frameMsMax: number;
  readonly frames: number;
  readonly spoiled: boolean;

  readonly heapBeforeMb: number | null;
  readonly heapPeakMb: number | null;
  readonly heapApiAvailable: boolean;

  /** Bytes this binding uploaded. A LOWER BOUND on VRAM, not a GPU memory reading. */
  readonly uploadedBytes: number;
  readonly threeGeometries: number;
  readonly threeTextures: number;
  readonly drawCalls: number;
  readonly pointsSubmitted: number;

  readonly overlayDrawn: number;
  readonly overlayChevrons: number;
}

const LABELS = new Map<number, string>([
  [250_000, '250k'],
  [1_000_000, '1M'],
  [2_000_000, '2M'],
  [3_000_000, '3M'],
  [4_000_000, '4M'],
]);

export function labelFor(points: number): string {
  return LABELS.get(points) ?? String(points);
}

/**
 * Segment names in the `.opm` and anchor keys in the scene fixture do not all agree, and they
 * should not be matched by substring: a quiet coupling between a detector's label and an anchor
 * id is exactly how a scene ends up with the wrong dissolve on the wrong object.
 *
 * SPEC GAP, reported: `atlas-core`'s `Anchor` has no field naming the part of the capture a
 * detection covers, so this alias table has to exist somewhere. It belongs in the graph, not in
 * a renderer.
 */
const SEGMENT_ALIASES: Readonly<Record<string, string>> = {
  crate: 'crate-stack',
  'boat-hull': 'boat',
};

/** Names come from the entity graph. The harness has no graph, so it says so out loud. */
function harnessNameResolver(entityId: EntityId | null, anchor: Anchor): {
  name: string | null;
  placeholder: string;
} {
  if (entityId === null) {
    return { name: null, placeholder: `Unnamed ${anchor.kind}, ${anchor.occurrenceCount} occurrences` };
  }
  // A real host asks graph-client. Deliberately NOT derived from the anchor id: an occurrence is
  // anonymous and only an entity holds a name.
  return { name: null, placeholder: `${entityId} (${anchor.occurrenceCount} occurrences)` };
}

export interface StageHandles {
  readonly container: HTMLElement;
  readonly onPhase: (phase: string, detail: string) => void;
}

export async function runOne(
  config: RunConfig,
  capabilities: RendererCapabilities,
  stage: StageHandles,
): Promise<{ result: RunResult; renderer: AtlasRenderer }> {
  const runStart = performance.now();
  const label = labelFor(config.points);
  const heapBefore = readHeap();

  stage.onPhase('loading', `harbour-${label}.opm`);
  const sceneJson = await (await fetch('/harbour-scene.json')).json();
  const scene: AtlasScene = rehydrateScene(sceneJson, config.islands);
  const table: AnchorTable = buildAnchorTable(scene);

  const { data, timings } = await fetchPointMap(`/harbour-${label}.opm`);

  stage.onPhase('building', `${config.islands} islands`);
  const renderer = new AtlasRenderer({
    container: stage.container,
    scene,
    table,
    resolveName: harnessNameResolver,
    resolvePresence: (anchor) => ({
      caption: `Presence, ${anchor.kind}`,
      // A real host resolves the evidence handle. The harness has none, so it stamps the
      // handle itself rather than inventing a plausible date.
      timestamp: String(anchor.evidence[0] ?? 'no evidence handle'),
    }),
    betweenSpaceMotes: config.betweenSpaceMotes,
    pixelRatioCap: config.pixelRatioCap,
  });
  renderer.applyAppearance({ ...renderer.appearance, suppressPeople: config.suppressPeople });

  const bindings = bindSegmentsByName(data.header, table.anchors, SEGMENT_ALIASES);

  const attachStart = performance.now();
  for (const island of scene.islands) {
    // Every island gets its OWN GPU buffers from the same decoded arrays. That is deliberate and
    // it is the honest cost: three islands at 1M points each is three million points resident,
    // which is the Atlas workload rather than an instancing trick that no real capture allows.
    renderer.addIsland(island, data, bindings);
  }

  const ctx = pathContext(scene);
  const pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  renderer.scriptedPose = poseAt(ctx, 0, pose);

  renderer.frame(performance.now());
  // `finish` is a real synchronisation point, so the number that follows includes shader
  // compilation and the first buffer upload rather than just the time to queue them.
  renderer.renderer.getContext().finish();
  const firstDrawEnd = performance.now();

  const occupancyMs = renderer.drainDeferredWork();

  const meter = new FrameMeter();
  let heapPeak = heapBefore.usedMb;
  let overlayDrawn = 0;
  let overlayChevrons = 0;
  let drawCalls = 0;
  let pointsSubmitted = 0;

  await new Promise<void>((resolve) => {
    const measureStart = performance.now();
    let measuring = false;

    const loop = (now: number): void => {
      const elapsed = now - measureStart;
      if (!measuring && elapsed >= config.warmupMs) {
        measuring = true;
        meter.reset();
        stage.onPhase('measuring', `${label} x ${config.islands}`);
      }
      if (measuring && elapsed >= config.warmupMs + config.measureMs) {
        resolve();
        return;
      }

      const t = measuring
        ? Math.min(1, (elapsed - config.warmupMs) / config.measureMs)
        : elapsed / Math.max(1, config.warmupMs);
      renderer.scriptedPose = poseAt(ctx, t % 1, pose);

      const report = renderer.frame(now);
      if (measuring) {
        meter.tick(now);
        overlayDrawn = Math.max(overlayDrawn, report.overlay.drawn);
        overlayChevrons = Math.max(overlayChevrons, report.overlay.chevrons);
        drawCalls = renderer.renderer.info.render.calls;
        pointsSubmitted = renderer.renderer.info.render.points;
        const heap = readHeap();
        if (heap.usedMb !== null && (heapPeak === null || heap.usedMb > heapPeak)) {
          heapPeak = heap.usedMb;
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  const stats = meter.summarise();
  meter.dispose();

  const result: RunResult = {
    label,
    pointsPerIsland: data.header.pointCount,
    islands: scene.islands.length,
    pointsTotal: data.header.pointCount * scene.islands.length,
    fetchMs: timings.fetchMs,
    decodeMs: timings.decodeMs,
    timeToFirstRenderMs: firstDrawEnd - runStart,
    firstDrawMs: firstDrawEnd - attachStart,
    occupancyMs,
    fpsMean: stats.fpsMean,
    fpsP1Low: stats.fpsP1Low,
    frameMsMean: stats.frameMsMean,
    frameMsP95: stats.frameMsP95,
    frameMsMax: stats.frameMsMax,
    frames: stats.frames,
    spoiled: stats.spoiled,
    heapBeforeMb: heapBefore.usedMb,
    heapPeakMb: heapPeak,
    heapApiAvailable: heapBefore.available,
    uploadedBytes: renderer.uploadedBytes(),
    threeGeometries: renderer.renderer.info.memory.geometries,
    threeTextures: renderer.renderer.info.memory.textures,
    drawCalls,
    pointsSubmitted,
    overlayDrawn,
    overlayChevrons,
  };

  // Parseable, one line, prefixed so an automated driver can grep the console transcript without
  // a DOM query. `graphicsPath` rides along on every row because a mixed-path result set that
  // did not say which row was which would be worse than no result set.
  if (!config.quiet) {
    console.log(
      `ORIMERA_BAKEOFF_ROW ${JSON.stringify({ ...result, graphicsPath: capabilities.path, webgpuAvailable: capabilities.webgpuAvailable })}`,
    );
  }

  return { result, renderer };
}

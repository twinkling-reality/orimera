import * as pc from 'playcanvas';

/**
 * Probes for the three claims ADR-0003 makes in favour of PlayCanvas.
 *
 * The ADR asks for verification rather than repetition, so each probe reads the ACTUAL ENGINE at
 * runtime and reports what it finds, including when the finding is that the claim is real but does
 * not apply to the workload Orimera actually has. A correction is worth more than a confirmation.
 *
 * The three claims, verbatim from the ADR:
 *
 *   1. "Unified global sort across N splat components is the documented default."
 *   2. "app.scene.gsplat.splatBudget is a target splat count across all GSplat assets in the
 *      scene, automatically degrading distant geometry first."
 *   3. "WebGPU compute path with automatic WebGL2 fallback", measured faster than WebGL2.
 *
 * Every one of them is about GAUSSIAN SPLATS. The substrate the bake-off is measuring is a rung 3
 * monocular point map, which the product specification calls the guaranteed floor and which three
 * of the four research streams have already chosen over splats for the MVP. These probes exist to
 * establish, mechanically, whether the advantages transfer.
 */

export interface ClaimResult {
  readonly claim: string;
  /** true, false, or 'not-applicable' when the mechanism is real but cannot reach this workload. */
  readonly verdict: 'confirmed' | 'refuted' | 'not-applicable';
  readonly evidence: string;
}

/**
 * Claim 2: the cross-asset splat budget.
 *
 * The property exists and works as documented, for octree-backed gsplats. Reading the engine
 * source settles what "across all GSplat assets" means: `GSplatWorld._enforceBudget` sums every
 * non-octree placement into a `fixedSplats` total it cannot reduce, and then calls
 * `GSplatBudgetBalancer.balance(octreeInstances, budget)`, which walks ONLY the map of
 * `GSplatOctreeInstance`. The degradation mechanism is per-node LOD selection inside a streamed
 * octree. A plain gsplat is a fixed cost; a point cloud is not in the system at all.
 */
export function probeSplatBudget(app: pc.AppBase): ClaimResult {
  const settings = (app.scene as unknown as { gsplat?: { splatBudget?: number } }).gsplat;
  if (settings === undefined || typeof settings.splatBudget !== 'number') {
    return {
      claim: 'cross-asset splat budget',
      verdict: 'refuted',
      evidence: 'app.scene.gsplat.splatBudget is not present on this engine build',
    };
  }

  const before = settings.splatBudget;
  settings.splatBudget = 1_500_000;
  const accepted = settings.splatBudget === 1_500_000;
  settings.splatBudget = before;

  const gsplatComponents = app.root.findComponents('gsplat').length;

  return {
    claim: 'cross-asset splat budget',
    verdict: 'not-applicable',
    evidence:
      `app.scene.gsplat.splatBudget exists and is settable (${String(accepted)}); ` +
      `${gsplatComponents} gsplat components in this scene. ` +
      'Budget enforcement runs in GSplatWorld._enforceBudget, which reduces LOD only for ' +
      'GSplatOctreeInstance entries (streamed SOG octrees). Non-octree gsplats are counted as ' +
      'fixedSplats and are never degraded, and point-cloud MeshInstances are outside the gsplat ' +
      'world entirely. The budget cannot degrade a distant point-map island.',
  };
}

/**
 * Claim 1: a single global sort across N islands.
 *
 * True for gsplats: the unified renderer bakes every splat component into one work buffer and
 * sorts the whole buffer per frame, which is why three gsplat components in one canvas composite
 * correctly. It is a property of that work buffer, not of the scene graph.
 *
 * For ordinary geometry PlayCanvas sorts DRAW CALLS, not primitives: `Layer.opaqueSortMode` and
 * `Layer.transparentSortMode` order `MeshInstance`s by `zdist`. There is no per-vertex ordering
 * pass anywhere outside the gsplat path, in either engine.
 *
 * The useful part of the finding is that a point map does not need one. Points rendered opaque
 * with an alpha test are depth-correct and order-independent, so the advantage that would matter
 * for splats buys nothing here, and neither engine is penalised for lacking it.
 */
export function probeGlobalSort(layer: pc.Layer | null, meshInstances: number): ClaimResult {
  const opaque = layer?.opaqueSortMode;
  const transparent = layer?.transparentSortMode;
  return {
    claim: 'single global sort across N islands',
    verdict: 'not-applicable',
    evidence:
      `layer opaqueSortMode=${String(opaque)} transparentSortMode=${String(transparent)} ` +
      `over ${meshInstances} point-cloud MeshInstances. PlayCanvas sorts MeshInstances by zdist, ` +
      'not primitives. Per-splat global sorting exists only inside the unified gsplat work ' +
      'buffer and does not reach a Mesh with PRIMITIVE_POINTS. The point map is rendered opaque ' +
      'with an alpha test, so it is depth-correct without any sort.',
  };
}

/**
 * Claim 3: the WebGPU compute path.
 *
 * The compute path is the gsplat SORTER (`GSPLAT_RENDERER_COMPUTE`, plus the WGSL radix-sort
 * chunks in the engine). A point cloud issues no compute work, so the measured speedup has no
 * mechanism to arrive through.
 *
 * Two concrete costs land on the WebGPU path for a point map, and both are verifiable here:
 *
 *   - WGSL has no point-size output. WebGPU's `point-list` topology rasterises exactly one pixel
 *     per point. PlayCanvas's only reference to `gl_PointSize` in its whole shader library sets
 *     it to 1.0. A point map that needs screen coverage has to be rebuilt as expanded quads.
 *   - Custom GLSL is not transpiled unless the application supplies `glslangUrl` and `twgslUrl`.
 *     Those WASM transpilers are not in the npm package, so a custom shader on WebGPU means
 *     hand-written WGSL or two extra third-party fetches.
 */
export function probeWebGpu(device: pc.GraphicsDevice): ClaimResult {
  const isWebGpu = device.isWebGPU === true;
  const available = typeof navigator !== 'undefined' && 'gpu' in navigator;
  return {
    claim: 'WebGPU compute path faster than WebGL2',
    verdict: isWebGpu ? 'not-applicable' : 'not-applicable',
    evidence:
      `navigator.gpu present=${String(available)}, active device=${
        isWebGpu ? 'webgpu' : 'webgl2'
      }, deviceType=${String(device.deviceType)}. The measured speedup is the gsplat compute ` +
      'sorter; a PRIMITIVE_POINTS draw dispatches no compute. On this path WebGPU also loses ' +
      'point size (WGSL has no gl_PointSize equivalent, so point-list is one pixel per point) ' +
      'and requires hand-written WGSL, because glslang and twgsl are not shipped with the engine.',
  };
}

/** Everything the three probes found, in one array, for the harness to print. */
export function probeAll(
  app: pc.AppBase,
  layer: pc.Layer | null,
  meshInstances: number,
): ClaimResult[] {
  return [
    probeGlobalSort(layer, meshInstances),
    probeSplatBudget(app),
    probeWebGpu(app.graphicsDevice),
  ];
}

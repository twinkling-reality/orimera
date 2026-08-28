/**
 * Which graphics path we are actually on, reported rather than assumed.
 *
 * ADR-0003 records this as the strongest argument AGAINST option A, and it is verified: Spark's
 * `SparkRenderer` takes a `THREE.WebGLRenderer` in its options and there is no WebGPU
 * constructor, so choosing three.js + Spark chooses WebGL2. This module does not hide that. It
 * probes for WebGPU anyway, because "WebGPU was available and we did not use it" is a different
 * fact from "WebGPU was not available", and the bake-off has to be able to tell them apart.
 *
 * Nothing here branches behaviour on the result. It is measurement, and it is printed.
 */

export type GraphicsPath = 'webgl2' | 'webgl1' | 'none';

export interface RendererCapabilities {
  /** The path this binding actually renders on. */
  readonly path: GraphicsPath;
  /** Whether `navigator.gpu` exists AND yielded an adapter. Probed, never assumed from the UA. */
  readonly webgpuAvailable: boolean;
  /** Why WebGPU is not the path, in one sentence, even when it was available. */
  readonly webgpuNote: string;
  readonly maxTextureSize: number;
  /** Points are drawn with `gl.POINTS`; a driver-clamped range caps the near-field sprite size. */
  readonly pointSizeRange: readonly [number, number];
  readonly unmaskedVendor: string;
  readonly unmaskedRenderer: string;
  /** Present only where `WEBGL_debug_renderer_info` is exposed; Chrome exposes it on desktop. */
  readonly debugInfoAvailable: boolean;
  /** `EXT_disjoint_timer_query_webgl2`, needed for real GPU timings rather than frame timings. */
  readonly timerQuery: boolean;
  /** Chrome only, and only over a coarse quantised heap. Absent elsewhere, reported as absent. */
  readonly memoryApi: boolean;
}

const NO_WEBGPU_BECAUSE =
  'Spark 2.1.0 SparkRendererOptions.renderer is typed THREE.WebGLRenderer, so the three.js + ' +
  'Spark binding is WebGL2 by construction. This is ADR-0003 option A cost, not a bug.';

export async function probeCapabilities(): Promise<RendererCapabilities> {
  const canvas = document.createElement('canvas');
  const gl2 = canvas.getContext('webgl2');
  const gl = gl2 ?? canvas.getContext('webgl');

  let webgpuAvailable = false;
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu !== undefined) {
    try {
      webgpuAvailable = (await gpu.requestAdapter()) !== null;
    } catch {
      webgpuAvailable = false;
    }
  }

  if (gl === null) {
    return Object.freeze({
      path: 'none' as const,
      webgpuAvailable,
      webgpuNote: NO_WEBGPU_BECAUSE,
      maxTextureSize: 0,
      pointSizeRange: Object.freeze([0, 0] as const),
      unmaskedVendor: 'unknown',
      unmaskedRenderer: 'unknown',
      debugInfoAvailable: false,
      timerQuery: false,
      memoryApi: 'memory' in performance,
    });
  }

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;

  const caps: RendererCapabilities = Object.freeze({
    path: gl2 !== null ? ('webgl2' as const) : ('webgl1' as const),
    webgpuAvailable,
    webgpuNote: NO_WEBGPU_BECAUSE,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    pointSizeRange: Object.freeze([range[0] ?? 0, range[1] ?? 0] as const),
    unmaskedVendor:
      dbg === null ? 'unavailable' : String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)),
    unmaskedRenderer:
      dbg === null ? 'unavailable' : String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)),
    debugInfoAvailable: dbg !== null,
    timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    memoryApi: 'memory' in performance,
  });

  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose !== null) lose.loseContext();
  return caps;
}

import type { Scene, WebGLRenderer } from 'three';
import type { Island } from '@orimera/atlas-core';

/**
 * THE SPARK HALF OF ADR-0003 OPTION A, AND AN HONEST ACCOUNT OF WHAT IT IS FOR.
 *
 * Spark renders Gaussian splats. The fixture this binding is measured on is a POINT MAP, which
 * is rung 3 on the reconstruction ladder and explicitly not splats: scene-synth rejected
 * encoding points as degenerate splats because that "would misrepresent the rung and would tilt
 * the bake-off toward whichever engine has the better splat path". So Spark is NOT in the hot
 * path of any number this harness reports, and saying otherwise would be the easiest way to
 * make the bake-off answer a question it did not ask.
 *
 * What this module is: the rung-1 path, wired and ready, so that when experiment X-1 produces a
 * real baked splat the same scene graph, the same placements, the same anchor overlay and the
 * same focus solver render it with no restructuring. A splat island and a point island are both
 * `Island`s in one `AtlasScene`, at their own placements, in the one canvas.
 *
 * Three facts about it that belong in the ADR rather than in a comment, but are true here:
 *
 *   1. `SparkRendererOptions.renderer` is typed `THREE.WebGLRenderer`. Adding Spark forecloses
 *      WebGPU for the whole application, not just for splats. See `capabilities.ts`.
 *   2. Spark ships LoD, a `SplatPager` LRU virtual paging system, chunked `.RAD` streaming and
 *      camera foveation, so the streaming story on three.js is complete rather than absent. That
 *      is the strongest single argument for option A and it is real.
 *   3. `.RAD` is a single-vendor format with no published spec. ADR-0003 fixes Streamed SOG as
 *      the delivery format, and Spark reads SOG through `SplatLoader`, so nothing here needs to
 *      adopt `.RAD` to get the LoD and paging benefits.
 *
 * The import is dynamic on purpose. Spark plus its worker is a large dependency and the rung-3
 * path is the guaranteed floor that every user gets; a point-map session must not download a
 * splat renderer to look at a photograph.
 *
 * NOT VERIFIED BY MEASUREMENT. No splat fixture exists in this repository, so this path has been
 * type-checked and never run against real splat bytes. It is reported as untested.
 */

export interface SparkIslandOptions {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly island: Island;
  /** A Streamed SOG `meta.json`, a `.spz`, or a `.ply`. SOG is the delivery format per ADR-0003. */
  readonly url: string;
  readonly onProgress?: (event: ProgressEvent) => void;
}

export interface SparkIslandHandle {
  /** The `SplatMesh`, typed loosely so this module's types do not leak Spark into the barrel. */
  readonly mesh: { position: { set(x: number, y: number, z: number): void } };
  readonly splatCount: number;
  dispose(): void;
}

let sparkRendererPromise: Promise<unknown> | null = null;

/**
 * Create the single scene-wide `SparkRenderer` on first use.
 *
 * One instance, because Spark accumulates and sorts every `SplatMesh` in the scene through it;
 * multiple instances exist for multi-viewport (a picture-in-picture of the source moment), not
 * for multiple islands.
 */
async function ensureSparkRenderer(renderer: WebGLRenderer, scene: Scene): Promise<unknown> {
  if (sparkRendererPromise !== null) return sparkRendererPromise;
  sparkRendererPromise = (async () => {
    const spark = await import('@sparkjsdev/spark');
    const sparkRenderer = new spark.SparkRenderer({ renderer });
    scene.add(sparkRenderer as unknown as never);
    return sparkRenderer;
  })();
  return sparkRendererPromise;
}

export async function addSparkIsland(options: SparkIslandOptions): Promise<SparkIslandHandle> {
  await ensureSparkRenderer(options.renderer, options.scene);
  const spark = await import('@sparkjsdev/spark');

  const mesh = await new Promise<InstanceType<typeof spark.SplatMesh>>((resolve, reject) => {
    try {
      const m = new spark.SplatMesh({
        url: options.url,
        // LoD and paging are the whole reason Spark is the three.js answer to PlayCanvas's
        // cross-asset splat budget. Enabled here rather than left to a caller who will forget.
        lod: true,
        paged: true,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        onLoad: (loaded: InstanceType<typeof spark.SplatMesh>) => resolve(loaded),
      });
      // Placement is identical to the point path: position, yaw about the shared up axis, and a
      // uniform scale. Islands are never pitched or rolled, so there is no quaternion to build.
      const p = options.island.placement;
      m.position.set(p.position.x, p.position.y, p.position.z);
      m.rotation.set(0, p.yaw, 0);
      m.scale.setScalar(p.scale);
      options.scene.add(m);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    mesh,
    splatCount: mesh.numSplats,
    dispose: () => {
      options.scene.remove(mesh);
      mesh.dispose();
    },
  };
}

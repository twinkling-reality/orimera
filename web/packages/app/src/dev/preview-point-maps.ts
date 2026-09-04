/**
 * The one reconstructed region in the preview, loaded from a real `.opm` on disk.
 *
 * This module is imported by the preview path only, for the same reason `preview-media.ts` is:
 * production reads its geometry from the API through `geometry-api.ts`, and a development build
 * that shipped a fixture path into that would be a second source of truth for what a region
 * contains.
 *
 * **It skips the digest check the production path is built around, and that is the difference
 * between the two.** There is no descriptor here to check against: the file is named by this
 * module and read from the dev server's own directory, so what would be verified is a claim
 * nobody made. The production loader refuses bytes that fail their digest and this one cannot,
 * which is one more reason it may only be reached behind `?preview=1` in a development build.
 *
 * **The file is a reconstruction, not a fixture.** `glasshouse-courtyard.opm` was produced by
 * `exulanica.reconstruction` from `glasshouse-courtyard.jpg`, the same photograph the courtyard
 * region already cites, and it is the decoder in `@exulanica/atlas-react` that reads it here.
 * That is the whole point of there being one decoder: the renderer cannot tell this from a
 * synthetic bake-off fixture, so what is on screen is a measurement of the real path.
 *
 * **A failure to load is reported and the region falls back to anchors.** A region with no
 * geometry is rung 4, which is a real rung with a real experience rather than an error state,
 * so a missing or corrupt file must not take the world down with it.
 */

import type { IslandId } from '@exulanica/atlas-core';
import type { PointMap } from '@exulanica/atlas-react/playcanvas';
import { decodeOpm } from '@exulanica/atlas-react/playcanvas';
import { PREVIEW_IDS } from './preview-graph.js';

/**
 * The island the reconstruction belongs to, and why it is the scene group's id.
 *
 * `groupIslands` keys every capture in a scene group by that group's `group_id`, so the region
 * holding `captureCourtyard` is `regionCourtyard`. Deriving it here rather than hard coding a
 * uuid keeps this in step with the preview graph if the grouping changes.
 */
const RECONSTRUCTED: readonly (readonly [IslandId, string])[] = [
  [PREVIEW_IDS.regionCourtyard as IslandId, '/fixtures/memory/glasshouse-courtyard.opm'],
];

export async function previewPointMaps(): Promise<ReadonlyMap<IslandId, PointMap>> {
  const loaded = new Map<IslandId, PointMap>();
  for (const [islandId, url] of RECONSTRUCTED) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      loaded.set(islandId, decodeOpm(await response.arrayBuffer()));
    } catch (cause) {
      // Reported rather than swallowed: an island silently missing its geometry looks exactly
      // like an island that never had any, and those are different states.
      console.warn(`[preview] no reconstruction for ${islandId} from ${url}:`, cause);
    }
  }
  return loaded;
}

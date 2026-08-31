import { atlasVec3, type AtlasVec3 } from './coords.js';
import type { NeighborhoodId } from './ids.js';
import type { NeighborhoodIndex } from './neighborhood.js';
import type { AtlasScene } from './scene.js';

export interface RenderOriginState {
  readonly origin: AtlasVec3;
  readonly neighborhoodId: NeighborhoodId | null;
  readonly revision: number;
}

export const INITIAL_RENDER_ORIGIN: RenderOriginState = Object.freeze({
  origin: atlasVec3(0, 0, 0),
  neighborhoodId: null,
  revision: 0,
});

/**
 * Choose a stable, quantized render origin for the active neighborhood. Canonical Atlas positions
 * never change; only the GPU-facing coordinate origin moves to keep float magnitudes bounded.
 */
export function renderOriginForNeighborhood(
  scene: AtlasScene,
  neighborhoods: NeighborhoodIndex,
  active: NeighborhoodId | null,
  previous: RenderOriginState = INITIAL_RENDER_ORIGIN,
  grid = 64,
): RenderOriginState {
  if (!Number.isFinite(grid) || grid <= 0) throw new RangeError('render-origin grid must be positive');
  if (active === null || active === previous.neighborhoodId) return previous;
  const neighborhood = neighborhoods.neighborhoods.find((value) => value.neighborhoodId === active);
  if (neighborhood === undefined) throw new RangeError(`unknown render-origin neighborhood: ${active}`);
  const islands = neighborhood.islandIds.flatMap((id) => {
    const island = scene.islands.find((value) => value.islandId === id);
    return island === undefined ? [] : [island];
  });
  if (islands.length === 0) return previous;
  const x = islands.reduce((sum, island) => sum + island.placement.position.x, 0) / islands.length;
  const z = islands.reduce((sum, island) => sum + island.placement.position.z, 0) / islands.length;
  const origin = atlasVec3(Math.round(x / grid) * grid, 0, Math.round(z / grid) * grid);
  if (
    origin.x === previous.origin.x &&
    origin.y === previous.origin.y &&
    origin.z === previous.origin.z
  ) {
    return Object.freeze({ ...previous, neighborhoodId: active });
  }
  return Object.freeze({ origin, neighborhoodId: active, revision: previous.revision + 1 });
}

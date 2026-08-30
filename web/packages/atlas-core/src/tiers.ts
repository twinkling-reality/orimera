import type { AtlasVec3 } from './coords.js';
import type { AnchorTable, AtlasScene } from './scene.js';
import type { IslandId } from './ids.js';
import { atlasGroundDistance } from './presentation-metrics.js';

/**
 * Representation tiers (interaction-model.md 1.4). Four tiers per island, cross-faded on
 * distance, ALL RESIDENT IN THE SAME SCENE. What changes as the user moves is representation
 * density, never scene identity.
 *
 * Distance is measured to the footprint boundary rather than the centre, and promotion and
 * demotion use asymmetric hysteresis (promote at d, demote at 1.25d) so a user standing on a
 * threshold does not flicker between two representations.
 */
export type RepresentationTier = 0 | 1 | 2 | 3;

/** Promotion thresholds, in atlas units to the footprint boundary. Demotion is 1.25x these. */
export const TIER_PROMOTE_AU: Readonly<Record<Exclude<RepresentationTier, 0>, number>> =
  Object.freeze({ 1: 180, 2: 90, 3: 25 });

export const TIER_DEMOTE_FACTOR = 1.25;

/** At most two islands may be at tier 3 at once (interaction-model.md 1.4). */
export const MAX_TIER_3_ISLANDS = 2;

export interface TierState {
  readonly tier: ReadonlyMap<IslandId, RepresentationTier>;
}

export const EMPTY_TIER_STATE: TierState = Object.freeze({ tier: new Map() });

/**
 * Map is an overview, not a very distant ground camera. Keep every region resident at the same
 * legible summary density instead of letting altitude accidentally demote the whole world.
 */
export function mapTierState(scene: AtlasScene): TierState {
  const tier = new Map<IslandId, RepresentationTier>();
  for (const island of scene.islands) tier.set(island.islandId, 1);
  return Object.freeze({ tier });
}

function distanceToFootprintBoundary(
  camera: AtlasVec3,
  centre: AtlasVec3,
  footprintRadiusAtlas: number,
): number {
  return Math.max(0, atlasGroundDistance(camera, centre) - footprintRadiusAtlas);
}

/**
 * Resolve every island's tier for this frame, applying hysteresis against the previous state and
 * the tier 3 cap.
 *
 * Deliberately pure and previous-state-in / next-state-out: the renderer binding owns the
 * cross-fade timing, atlas-core owns which tier is correct. That split is what keeps the tier
 * rules identical under either ADR-0003 outcome.
 */
export function resolveTiers(
  scene: AtlasScene,
  table: AnchorTable,
  camera: AtlasVec3,
  previous: TierState = EMPTY_TIER_STATE,
): TierState {
  const scored: Array<{ id: IslandId; d: number; tier: RepresentationTier }> = [];

  for (const island of scene.islands) {
    const radiusAtlas = island.footprintRadiusLocal * island.placement.scale;
    const d = distanceToFootprintBoundary(camera, island.placement.position, radiusAtlas);
    const prev = previous.tier.get(island.islandId) ?? 0;

    let tier: RepresentationTier = 0;
    for (const candidate of [3, 2, 1] as const) {
      const promote = TIER_PROMOTE_AU[candidate];
      const threshold = prev >= candidate ? promote * TIER_DEMOTE_FACTOR : promote;
      if (d < threshold) {
        tier = candidate;
        break;
      }
    }
    scored.push({ id: island.islandId, d, tier });
  }

  // The tier 3 cap. Nearest wins; ties broken by table order so the result is deterministic.
  const atThree = scored
    .filter((s) => s.tier === 3)
    .sort((a, b) => a.d - b.d || table.islandIndexOf.get(a.id)! - table.islandIndexOf.get(b.id)!);
  for (const extra of atThree.slice(MAX_TIER_3_ISLANDS)) extra.tier = 2;

  const tier = new Map<IslandId, RepresentationTier>();
  for (const s of scored) tier.set(s.id, s.tier);
  return Object.freeze({ tier });
}

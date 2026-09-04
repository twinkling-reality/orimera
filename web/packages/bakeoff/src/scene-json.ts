import type { AtlasScene, EntityId, Island } from '@exulanica/atlas-core';
import { entityId, makeIsland, makeScene } from '@exulanica/atlas-core';

/**
 * Rehydrate `harbour-scene.json` into a real `AtlasScene`.
 *
 * scene-synth's note is exact and worth restating, because it is the one place a cast here is
 * sound rather than lazy: atlas-core's branded types erase completely at runtime. `IslandId` IS
 * a string, `AtlasVec3` IS `{x, y, z}`, so `JSON.parse(text) as AtlasScene` is correct. The one
 * exception is `layoutEntities`, which is a `Set` in the type and an array on the wire.
 *
 * This is also the boundary the dependency contract cares about: the harness may NOT import
 * scene-synth (it is an offline tool that reaches for `node:fs`), so the fixture crosses as
 * bytes and is reconstructed here through atlas-core's own constructors.
 */

interface SerializedIsland extends Omit<Island, 'layoutEntities'> {
  readonly layoutEntities: readonly string[];
}

interface SerializedScene {
  readonly layoutVersion: number;
  readonly stateVersion: number;
  readonly islands: readonly SerializedIsland[];
}

export function rehydrateScene(json: unknown, islandLimit?: number): AtlasScene {
  const raw = json as SerializedScene;
  const islands = (islandLimit === undefined ? raw.islands : raw.islands.slice(0, islandLimit)).map(
    (i) =>
      makeIsland({
        ...(i as unknown as Island),
        layoutEntities: new Set<EntityId>(i.layoutEntities.map(entityId)),
      }),
  );
  return makeScene(islands, raw.layoutVersion, raw.stateVersion);
}

import type { Anchor } from './anchor.js';
import type { AtlasVec3 } from './coords.js';
import { atlasVec3, localToAtlas } from './coords.js';
import type { AnchorId, IslandId } from './ids.js';
import type { Island } from './island.js';

/**
 * There is exactly one scene graph for the entire lifetime of a session (interaction-model.md
 * 1.1). No scene loading, no "enter", no "return". The Atlas Map is a camera pose. Recomposition
 * is a per-object uniform change. Processing formation happens in the world where the island
 * will be. All five of those follow from this one object never being replaced.
 */
export interface AtlasScene {
  readonly islands: readonly Island[];
  /** Bumped only when the persisted layout changes. Rare, announced, and slow when it does. */
  readonly layoutVersion: number;
  /** The graph state version this scene was built against. Invalidates view manifests. */
  readonly stateVersion: number;
}

export function makeScene(
  islands: readonly Island[],
  layoutVersion: number,
  stateVersion: number,
): AtlasScene {
  return Object.freeze({ islands: Object.freeze([...islands]), layoutVersion, stateVersion });
}

/**
 * The stable index table the whole render path hangs off.
 *
 * interaction-model.md 7.5 (the performance contract): "Anchors are drawn as one instanced mesh
 * per region with a per-instance emphasis attribute, so a manifest change writes one typed array
 * and flags it." That requires a stable anchor index and one contiguous run per island. This
 * table is that, and it is built once per layout change rather than per frame.
 *
 * Ordering is total and deterministic: islands by (createdAt, islandId), anchors by anchorId.
 * Two processes given the same scene build byte-identical tables, which is what lets the
 * bake-off compare two renderers on the same instance buffer.
 */
export interface AnchorTable {
  readonly count: number;
  readonly anchorIds: readonly AnchorId[];
  readonly anchors: readonly Anchor[];
  readonly indexOf: ReadonlyMap<AnchorId, number>;

  readonly islandIds: readonly IslandId[];
  readonly islandIndexOf: ReadonlyMap<IslandId, number>;
  /** [start, count] into the anchor arrays, one contiguous run per island. */
  readonly islandRange: ReadonlyMap<IslandId, readonly [number, number]>;

  /**
   * Atlas-space positions, 3 floats per anchor, in table order.
   *
   * Precomputed here so that neither the focus solver nor the renderer re-derives them per
   * frame, and so that the presentation transform is applied in exactly one place.
   */
  readonly atlasPositions: Float32Array;
  /** Focus volume radius in ATLAS units (local radius times the island's presentation scale). */
  readonly focusRadii: Float32Array;
}

function compareIslands(a: Island, b: Island): number {
  if (a.creationOrdinal !== b.creationOrdinal) return a.creationOrdinal - b.creationOrdinal;
  return a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0;
}

export function buildAnchorTable(scene: AtlasScene): AnchorTable {
  const islands = [...scene.islands].sort(compareIslands);

  const anchorIds: AnchorId[] = [];
  const anchors: Anchor[] = [];
  const indexOf = new Map<AnchorId, number>();
  const islandIds: IslandId[] = [];
  const islandIndexOf = new Map<IslandId, number>();
  const islandRange = new Map<IslandId, readonly [number, number]>();

  for (const island of islands) {
    const start = anchors.length;
    const sorted = [...island.anchors].sort((a, b) =>
      a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0,
    );
    for (const a of sorted) {
      if (indexOf.has(a.anchorId)) {
        throw new Error(`duplicate anchorId in scene: ${a.anchorId}`);
      }
      indexOf.set(a.anchorId, anchors.length);
      anchorIds.push(a.anchorId);
      anchors.push(a);
    }
    islandIndexOf.set(island.islandId, islandIds.length);
    islandIds.push(island.islandId);
    islandRange.set(island.islandId, [start, anchors.length - start]);
  }

  const atlasPositions = new Float32Array(anchors.length * 3);
  const focusRadii = new Float32Array(anchors.length);
  const byId = new Map(islands.map((i) => [i.islandId, i]));

  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i]!;
    const island = byId.get(a.islandId);
    if (island === undefined) {
      throw new Error(`anchor ${a.anchorId} references unknown island ${a.islandId}`);
    }
    const p = localToAtlas(island.placement, a.local);
    atlasPositions[i * 3] = p.x;
    atlasPositions[i * 3 + 1] = p.y;
    atlasPositions[i * 3 + 2] = p.z;
    focusRadii[i] = a.focusRadiusLocal * island.placement.scale;
  }

  return Object.freeze({
    count: anchors.length,
    anchorIds: Object.freeze(anchorIds),
    anchors: Object.freeze(anchors),
    indexOf,
    islandIds: Object.freeze(islandIds),
    islandIndexOf,
    islandRange,
    atlasPositions,
    focusRadii,
  });
}

/** Read one anchor's atlas position out of the table without allocating in a loop. */
export function anchorAtlasPosition(table: AnchorTable, index: number): AtlasVec3 {
  return atlasVec3(
    table.atlasPositions[index * 3]!,
    table.atlasPositions[index * 3 + 1]!,
    table.atlasPositions[index * 3 + 2]!,
  );
}

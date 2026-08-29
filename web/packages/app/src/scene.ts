/**
 * Graph data becomes an `AtlasScene`. This is the adapter the boundary exists for.
 *
 * `atlas-core` imports no other workspace package, including `graph-client`, so somebody has to
 * do this conversion and it is the caller. Doing it here rather than inside either package is
 * what keeps the scene graph testable with no transport and keeps a renderer switch to two
 * packages (`.dependency-cruiser.cjs`, `atlas-core-is-self-contained`).
 *
 * Three decisions in this file are epistemic rather than graphical, and each is the honest read
 * of what the system currently knows.
 *
 * **The rung is the one the pipeline recorded, and it is displayed rather than hidden.**
 * `product-specification.md` 5.1: "the reconstruction rung a scene earned is displayed, not
 * hidden. The ladder is the honesty feature." A region the pipeline has not reconstructed carries
 * no rung at all, and that is not the same fact as rung 4: rung 4 means reconstruction ran and
 * there was too little to place. An unreconstructed region falls back to rung 4 for the SCENE
 * GRAPH, because the scene graph has to render something and no geometry is what rung 4 is, and
 * the interface says which of the two it is from the record rather than from the scene.
 *
 * **No island is metric.** `scaleIsMetric: false` is what makes `asMetricLocal` return null, and
 * that null is what makes a spatial question refuse with a stated reason instead of estimating.
 * A layout position is not a measurement and this is where that stops being a sentence in a
 * document and becomes a flag the query path reads.
 *
 * **Anchor positions inside an island are presentation, and nothing may read them as
 * measurement.** Without reconstruction there is no recovered position for a detection, so the
 * anchors are seeded on a deterministic phyllotaxis disc: the same graph produces the same
 * arrangement on every machine and on every run, and no arrangement claims anything. That is the
 * same rule the standing caption states to the user in words, and `scaleIsMetric: false` is what
 * enforces it in code.
 */

import type {
  Anchor,
  AnchorKind,
  AtlasScene,
  Island,
  IslandPlacement,
  LayoutInputIsland,
  ReconstructionRung,
} from '@orimera/atlas-core';
import {
  DEFAULT_LAYOUT_CONFIG,
  MAX_ISLANDS,
  anchorId,
  atlasVec3,
  entityId as toEntityId,
  islandId as toIslandId,
  layoutEntitiesOf,
  localVec3,
  makeIsland,
  makeScene,
  occurrenceId as toOccurrenceId,
  phyllotaxisSeed,
  placement,
  solveLayout,
} from '@orimera/atlas-core';
import type { EvidenceRef } from '@orimera/atlas-core';
import type {
  GraphSnapshot,
  IslandRecord,
  OccurrenceKind,
  OccurrenceRecord,
} from '@orimera/graph-client';

/**
 * What an island renders as when nothing has reconstructed it.
 *
 * Rung 4 is "evidence cards laid out by time and semantic proximity. No geometry", which is
 * exactly what a region with no point map is, so the SCENE GRAPH is right to say 4. What the
 * record says is separate and is null, and the interface reads the record rather than the scene
 * when it explains the rung, because "nothing has run" and "it ran and found nothing" are two
 * different sentences.
 */
export const NO_GEOMETRY_RUNG: ReconstructionRung = 4;

/** Local units. The disc the anchors of one island are seeded on. */
const ANCHOR_DISC_SPACING = 1.6;

/** Local units. Wide enough that a small nearby anchor is aimable without pixel-precise aim. */
const ANCHOR_FOCUS_RADIUS = 0.55;

/** Local units of clearance beyond the outermost anchor, so nothing sits on the dissolve edge. */
const FOOTPRINT_MARGIN = 2.5;

export interface SceneBuild {
  readonly scene: AtlasScene;
  /**
   * Islands the layout solver could not take, with the reason.
   *
   * `solveLayout` refuses more than five islands and says why: a force layout whose behaviour
   * was never examined above five should fail loudly rather than produce a plausible-looking
   * arrangement nobody has checked. So this returns what was left out instead of silently
   * arranging everything, and the interface says so rather than showing a smaller world as if it
   * were the whole one.
   */
  readonly omitted: readonly IslandRecord[];
  /**
   * Occurrence classes the scene graph has no shape for, with how many were dropped.
   *
   * Reported rather than swallowed. A detection that does not appear in the Atlas is a detection
   * the user cannot ask about, and a count of zero and a count of forty look identical in a
   * world that simply does not draw them.
   */
  readonly undrawable: ReadonlyMap<OccurrenceKind, number>;
}

/**
 * Which anchor kind an occurrence class maps to.
 *
 * A closed mapping rather than a cast, and the two missing entries are the point. `voice` and
 * `conversation` are real `occurrence_class` values with no shape in the scene graph, so an
 * occurrence of either is DROPPED rather than coerced. `AnchorKind` is "occurrence_class minus
 * the deferred kinds", and coercing a deferred kind to the nearest available one would render a
 * conversation as an object sitting in a room.
 *
 * The `person` entry is the one that matters most. `rendersAsPresenceMarker` reads this to
 * decide between a time-anchored presence marker and world geometry, so a person mapped to
 * `object` would be a person baked into a reconstruction, which is the thing the whole anchor
 * design exists to prevent.
 */
const ANCHOR_KINDS: Readonly<Partial<Record<OccurrenceKind, AnchorKind>>> = Object.freeze({
  person: 'person',
  place: 'place',
  object: 'object',
  event: 'event',
});

export function buildScene(snapshot: GraphSnapshot, layoutVersion = 1): SceneBuild {
  const kept = snapshot.islands.slice(0, MAX_ISLANDS);
  const omitted = snapshot.islands.slice(MAX_ISLANDS);

  // Importance is driven by how often the linked entity appears across the WHOLE workspace,
  // not within one island, so it is read from the entity rather than counted here.
  const occurrenceCounts = new Map(
    snapshot.entities.map((entity) => [entity.entityId, entity.occurrenceCount] as const),
  );
  const anchorsByIsland = new Map<string, Anchor[]>();
  const undrawable = new Map<OccurrenceKind, number>();
  for (const occurrence of snapshot.occurrences) {
    const kind = ANCHOR_KINDS[occurrence.kind];
    if (kind === undefined) {
      undrawable.set(occurrence.kind, (undrawable.get(occurrence.kind) ?? 0) + 1);
      continue;
    }
    const list = anchorsByIsland.get(occurrence.islandId);
    const linked = occurrence.entityId;
    const count = linked === null ? 0 : (occurrenceCounts.get(linked) ?? 0);
    const anchor = toAnchor(occurrence, kind, count);
    if (list === undefined) anchorsByIsland.set(occurrence.islandId, [anchor]);
    else list.push(anchor);
  }

  // Seeded per island, after the anchors are gathered, so the arrangement depends only on how
  // many there are and on their order. Sorted by id first: the graph returns occurrences in a
  // stable order today, and depending on that rather than imposing one would make the layout of
  // a region an accident of a query plan.
  const placed = kept.map((record) => {
    const anchors = (anchorsByIsland.get(record.islandId) ?? []).sort((a, b) =>
      a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0,
    );
    return { record, anchors: seedAnchors(anchors) };
  });

  const inputs: LayoutInputIsland[] = placed.map(({ record, anchors }) => ({
    islandId: toIslandId(record.islandId),
    createdAt: orderingKey(record),
    footprintRadiusLocal: footprintOf(anchors),
    scale: 1,
    layoutEntities: layoutEntitiesOf(anchors),
    pinned: null,
  }));

  const layout = solveLayout(inputs, layoutVersion, DEFAULT_LAYOUT_CONFIG);

  const islands: Island[] = placed.map(({ record, anchors }) =>
    makeIsland({
      islandId: toIslandId(record.islandId),
      createdAt: orderingKey(record),
      placement: layout.placements.get(toIslandId(record.islandId)) ?? originPlacement(),
      rung: record.rung ?? NO_GEOMETRY_RUNG,
      // Not metric even at rung 3. A monocular point map has a real metric scale of its own,
      // but an island's frame is the ATLAS's, and where a region sits there is a layout
      // decision carrying no real-world meaning. Making the island metric would let a query
      // measure across a placement, which is risk R-48. The metric frame that does exist is
      // the point map's, and a question answered from it has to go through the point map.
      scaleIsMetric: false,
      footprintRadiusLocal: footprintOf(anchors),
      // The centre of the disc, at eye height. Not "where the camera stood": nothing recovered a
      // camera pose, and `viewpointLocal` on a rung 4 island is where the first run arrives
      // rather than a claim about where anybody was standing.
      viewpointLocal: localVec3(0, 1.6, 0),
      anchors,
      layoutEntities: layoutEntitiesOf(anchors),
    }),
  );

  return {
    scene: makeScene(islands, layout.layoutVersion, snapshot.stateVersion),
    omitted,
    undrawable,
  };
}

/**
 * The layout solver's ordering key.
 *
 * `Island.createdAt` is documented as the ordering key and explicitly not a claim about when the
 * photographs were taken, so this uses the earliest capture time where there is one and sorts an
 * island with no usable clock LAST rather than to the epoch. Sorting an undated photograph first
 * would make it the anchor of the user's spatial memory of the whole library, which is the exact
 * outcome the pinning rule in interaction-model.md 1.4 exists to avoid.
 */
function orderingKey(record: IslandRecord): number {
  return record.firstCapturedAtMs ?? Number.MAX_SAFE_INTEGER;
}

function toAnchor(
  occurrence: OccurrenceRecord,
  kind: AnchorKind,
  occurrenceCount: number,
): Anchor {
  return {
    anchorId: anchorId(occurrence.anchorId),
    islandId: toIslandId(occurrence.islandId),
    occurrenceId: toOccurrenceId(occurrence.occurrenceId),
    kind,
    local: localVec3(0, 0, 0),
    focusRadiusLocal: ANCHOR_FOCUS_RADIUS,
    entityId: occurrence.entityId === null ? null : toEntityId(occurrence.entityId),
    linkState: occurrence.linkState,
    // Every occurrence in this corpus was written by a detector, and a detection is an inference
    // however confident it was (epi-1). The class is the producer's, not the link's.
    provenance: 'inference',
    confidence: occurrence.confidence,
    occurrenceCount,
    // Resolved means there is nothing left to ask. An unlinked detection is exactly a thing
    // there is something left to ask about, and it takes the slower cooler pulse that says so.
    resolved: occurrence.linkState === 'confirmed',
    evidence: occurrence.evidence as readonly EvidenceRef[],
  };
}

/** Place anchors on a deterministic disc. Presentation, and the island is not metric. */
function seedAnchors(anchors: readonly Anchor[]): readonly Anchor[] {
  const seed = phyllotaxisSeed(anchors.length, ANCHOR_DISC_SPACING);
  return anchors.map((anchor, index) => {
    const point = seed[index];
    return point === undefined ? anchor : { ...anchor, local: localVec3(point.x, 0, point.z) };
  });
}

function footprintOf(anchors: readonly Anchor[]): number {
  let furthest = 0;
  for (const anchor of anchors) {
    const distance = Math.hypot(anchor.local.x, anchor.local.z);
    if (distance > furthest) furthest = distance;
  }
  return furthest + FOOTPRINT_MARGIN;
}

function originPlacement(): IslandPlacement {
  return placement(atlasVec3(0, 0, 0), 0, 1);
}

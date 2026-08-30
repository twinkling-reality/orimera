import type { AtlasVec3 } from './coords.js';
import { atlasVec3 } from './coords.js';
import type { EntityId, IslandId, NeighborhoodId } from './ids.js';
import { neighborhoodId } from './ids.js';
import type {
  AtlasNeighborhoodReason,
  AtlasNeighborhoodSnapshot,
  NeighborhoodCoverage,
} from './neighborhood-snapshot.js';
import {
  inspectNeighborhoodCoverage,
  makeAtlasNeighborhoodSnapshot,
} from './neighborhood-snapshot.js';
import type { AtlasScene } from './scene.js';

export const DEFAULT_NEIGHBORHOOD_CAPACITY = 24;
export const DEFAULT_MAX_SEMANTIC_ROUTES_PER_NEIGHBORHOOD = 6;
export const DEFAULT_SEMANTIC_ENTITY_FANOUT_LIMIT = 64;

export interface Neighborhood {
  readonly neighborhoodId: NeighborhoodId;
  readonly firstCreationOrdinal: number;
  readonly islandIds: readonly IslandId[];
  readonly centre: AtlasVec3;
  readonly radius: number;
  readonly adjacent: readonly NeighborhoodId[];
}

export interface NeighborhoodRoute {
  readonly from: NeighborhoodId;
  readonly to: NeighborhoodId;
  /** Semantic routes encode confirmed overlap. Index routes encode navigation only. */
  readonly kind: 'semantic' | 'index';
  readonly strength: number;
}

export interface NeighborhoodIndex {
  readonly layoutVersion: number;
  readonly capacity: number;
  readonly membershipVersion: number | null;
  readonly membershipCoverage: NeighborhoodCoverage | null;
  readonly neighborhoods: readonly Neighborhood[];
  readonly byId: ReadonlyMap<NeighborhoodId, Neighborhood>;
  readonly neighborhoodOf: ReadonlyMap<IslandId, NeighborhoodId>;
  readonly routes: readonly NeighborhoodRoute[];
}

export interface NeighborhoodOptions {
  readonly capacity?: number;
  /** Bounds visual and query fan-out even when many entities connect the same working sets. */
  readonly maxSemanticRoutesPerNeighborhood?: number;
  /** Ubiquitous entities remain searchable but stop acting as useful neighborhood discriminators. */
  readonly semanticEntityFanoutLimit?: number;
  /** Durable authority. Missing regions form new draft groups; stored groups never reshuffle. */
  readonly snapshot?: AtlasNeighborhoodSnapshot;
}

export interface NeighborhoodSnapshotVersion {
  readonly neighborhoodVersion: number;
  readonly previousNeighborhoodVersion: number | null;
  readonly reason: AtlasNeighborhoodReason;
}

interface RegionRecord {
  readonly index: number;
  readonly islandId: IslandId;
  readonly creationOrdinal: number;
  readonly entities: ReadonlySet<EntityId>;
  readonly position: AtlasVec3;
  readonly radius: number;
}

const compareRegion = (a: RegionRecord, b: RegionRecord): number =>
  a.creationOrdinal - b.creationOrdinal ||
  (a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0);

const orderedPair = (
  a: NeighborhoodId,
  b: NeighborhoodId,
): readonly [NeighborhoodId, NeighborhoodId] => (a < b ? [a, b] : [b, a]);

const routeKey = (a: NeighborhoodId, b: NeighborhoodId): string => {
  const [from, to] = orderedPair(a, b);
  return `${from}\u0000${to}`;
};

/**
 * Build a lightweight full-library neighborhood index from confirmed layout entity sets.
 *
 * This is deterministic partitioning, not durable membership authority. Production persists the
 * resulting membership beside the layout snapshot; rerunning is for initial layout and migration.
 */
export function buildNeighborhoodIndex(
  scene: AtlasScene,
  options: NeighborhoodOptions = {},
): NeighborhoodIndex {
  if (
    options.snapshot !== undefined &&
    options.snapshot.layoutVersion !== scene.layoutVersion
  ) {
    throw new RangeError('neighborhood snapshot layoutVersion does not match the scene');
  }
  if (
    options.snapshot !== undefined &&
    options.capacity !== undefined &&
    options.capacity !== options.snapshot.capacity
  ) {
    throw new RangeError('neighborhood capacity disagrees with the durable snapshot');
  }
  const capacity = options.snapshot?.capacity ?? options.capacity ?? DEFAULT_NEIGHBORHOOD_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('neighborhood capacity must be a positive safe integer');
  }
  const maxSemanticRoutes = options.maxSemanticRoutesPerNeighborhood ??
    DEFAULT_MAX_SEMANTIC_ROUTES_PER_NEIGHBORHOOD;
  const semanticEntityFanoutLimit = options.semanticEntityFanoutLimit ??
    DEFAULT_SEMANTIC_ENTITY_FANOUT_LIMIT;
  if (!Number.isSafeInteger(maxSemanticRoutes) || maxSemanticRoutes < 0) {
    throw new RangeError('max semantic routes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(semanticEntityFanoutLimit) || semanticEntityFanoutLimit < 2) {
    throw new RangeError('semantic entity fanout limit must be a safe integer of at least two');
  }
  const records: RegionRecord[] = scene.islands.map((island, index) => ({
    index,
    islandId: island.islandId,
    creationOrdinal: island.creationOrdinal,
    entities: island.layoutEntities,
    position: island.placement.position,
    radius: island.footprintRadiusLocal * island.placement.scale,
  })).sort(compareRegion);
  const recordIndexById = new Map(
    records.map((record, index) => [record.islandId, index] as const),
  );

  const byEntity = new Map<EntityId, number[]>();
  for (let i = 0; i < records.length; i += 1) {
    for (const entity of records[i]!.entities) {
      const list = byEntity.get(entity);
      if (list === undefined) byEntity.set(entity, [i]);
      else list.push(i);
    }
  }

  interface Group {
    readonly members: number[];
    readonly neighborhoodId?: NeighborhoodId;
    readonly firstCreationOrdinal?: number;
  }
  const unassigned = new Set(records.map((_record, index) => index));
  const groups: Group[] = [];
  for (const entry of options.snapshot?.entries ?? []) {
    const members = entry.islandIds
      .map((id) => recordIndexById.get(id))
      .filter((value): value is number => value !== undefined);
    if (members.length === 0) continue;
    members.sort((a, b) => compareRegion(records[a]!, records[b]!));
    for (const member of members) unassigned.delete(member);
    groups.push({
      members,
      neighborhoodId: entry.neighborhoodId,
      firstCreationOrdinal: entry.firstCreationOrdinal,
    });
  }
  // Assign draft membership in one chronological pass. Entity-to-group postings preserve rare,
  // discriminating affinity without repeatedly rescanning every unassigned region. Ubiquitous
  // entities are intentionally ignored for grouping: they carry almost no neighborhood signal
  // and otherwise turn a 10k-region archive into quadratic work.
  const firstDraftGroup = groups.length;
  const groupsByEntity = new Map<EntityId, number[]>();
  for (const member of unassigned) {
    const record = records[member]!;
    const scores = new Map<number, number>();
    for (const entity of record.entities) {
      if ((byEntity.get(entity)?.length ?? 0) > semanticEntityFanoutLimit) continue;
      for (const groupIndex of groupsByEntity.get(entity) ?? []) {
        const group = groups[groupIndex]!;
        if (group.members.length >= capacity) continue;
        scores.set(groupIndex, (scores.get(groupIndex) ?? 0) + 1);
      }
    }
    let winner: number | null = null;
    let winnerScore = 0;
    for (const [groupIndex, score] of scores) {
      if (score > winnerScore || (score === winnerScore && (winner === null || groupIndex < winner))) {
        winner = groupIndex;
        winnerScore = score;
      }
    }
    if (winner === null) {
      const lastDraft = groups.length - 1;
      winner = lastDraft >= firstDraftGroup && groups[lastDraft]!.members.length < capacity
        ? lastDraft
        : groups.push({ members: [] }) - 1;
    }
    groups[winner]!.members.push(member);
    for (const entity of record.entities) {
      if ((byEntity.get(entity)?.length ?? 0) > semanticEntityFanoutLimit) continue;
      const postings = groupsByEntity.get(entity);
      if (postings === undefined) groupsByEntity.set(entity, [winner]);
      else if (postings[postings.length - 1] !== winner && !postings.includes(winner)) postings.push(winner);
    }
  }

  const neighborhoodOf = new Map<IslandId, NeighborhoodId>();
  const draft = groups.map((group) => {
    const members = group.members;
    const first = records[members[0]!]!;
    const id = group.neighborhoodId ?? neighborhoodId(`neighborhood:${first.islandId}`);
    let x = 0;
    let z = 0;
    for (const member of members) {
      x += records[member]!.position.x;
      z += records[member]!.position.z;
      neighborhoodOf.set(records[member]!.islandId, id);
    }
    const centre = atlasVec3(x / members.length, 0, z / members.length);
    let radius = 0;
    for (const member of members) {
      const region = records[member]!;
      radius = Math.max(
        radius,
        Math.hypot(region.position.x - centre.x, region.position.z - centre.z) + region.radius,
      );
    }
    return {
      neighborhoodId: id,
      firstCreationOrdinal: group.firstCreationOrdinal ?? first.creationOrdinal,
      islandIds: Object.freeze(members.map((member) => records[member]!.islandId)),
      centre,
      radius,
    };
  });

  const semanticCount = new Map<string, number>();
  for (const regionIndices of byEntity.values()) {
    const ids = [...new Set(
      regionIndices.map((index) => neighborhoodOf.get(records[index]!.islandId)!),
    )].sort();
    if (ids.length > semanticEntityFanoutLimit) continue;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = routeKey(ids[i]!, ids[j]!);
        semanticCount.set(key, (semanticCount.get(key) ?? 0) + 1);
      }
    }
  }

  const entityCount = new Map<NeighborhoodId, number>();
  const recordById = new Map(records.map((record) => [record.islandId, record] as const));
  for (const neighborhood of draft) {
    const entities = new Set<EntityId>();
    for (const island of neighborhood.islandIds) {
      const region = recordById.get(island)!;
      for (const entity of region.entities) entities.add(entity);
    }
    entityCount.set(neighborhood.neighborhoodId, entities.size);
  }

  const semanticCandidates: NeighborhoodRoute[] = [];
  for (const [key, shared] of semanticCount) {
    const [fromRaw, toRaw] = key.split('\u0000');
    const from = neighborhoodId(fromRaw!);
    const to = neighborhoodId(toRaw!);
    const denominator = Math.sqrt(
      Math.max(1, (entityCount.get(from) ?? 0) * (entityCount.get(to) ?? 0)),
    );
    semanticCandidates.push(Object.freeze({
      from,
      to,
      kind: 'semantic' as const,
      strength: Math.min(1, shared / denominator),
    }));
  }
  semanticCandidates.sort(
    (a, b) =>
      b.strength - a.strength ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
  const routes: NeighborhoodRoute[] = [];
  const semanticDegree = new Map<NeighborhoodId, number>();
  const selectedSemantic = new Set<string>();
  for (const route of semanticCandidates) {
    if (
      (semanticDegree.get(route.from) ?? 0) >= maxSemanticRoutes ||
      (semanticDegree.get(route.to) ?? 0) >= maxSemanticRoutes
    ) continue;
    routes.push(route);
    selectedSemantic.add(routeKey(route.from, route.to));
    semanticDegree.set(route.from, (semanticDegree.get(route.from) ?? 0) + 1);
    semanticDegree.set(route.to, (semanticDegree.get(route.to) ?? 0) + 1);
  }

  // A navigational chain guarantees that isolated neighborhoods remain reachable without
  // pretending the chain is a semantic relationship.
  for (let i = 0; i < draft.length - 1; i += 1) {
    const [from, to] = orderedPair(draft[i]!.neighborhoodId, draft[i + 1]!.neighborhoodId);
    if (selectedSemantic.has(routeKey(from, to))) continue;
    routes.push(Object.freeze({ from, to, kind: 'index' as const, strength: 0 }));
  }
  routes.sort(
    (a, b) =>
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );

  const adjacent = new Map<NeighborhoodId, Set<NeighborhoodId>>();
  for (const neighborhood of draft) adjacent.set(neighborhood.neighborhoodId, new Set());
  for (const route of routes) {
    adjacent.get(route.from)!.add(route.to);
    adjacent.get(route.to)!.add(route.from);
  }
  const neighborhoods: Neighborhood[] = draft.map((value) => Object.freeze({
    ...value,
    adjacent: Object.freeze([...adjacent.get(value.neighborhoodId)!].sort()),
  }));
  const byId = new Map(neighborhoods.map((value) => [value.neighborhoodId, value] as const));
  return Object.freeze({
    layoutVersion: scene.layoutVersion,
    capacity,
    membershipVersion: options.snapshot?.neighborhoodVersion ?? null,
    membershipCoverage:
      options.snapshot === undefined
        ? null
        : inspectNeighborhoodCoverage(
            options.snapshot,
            records.map((record) => record.islandId),
          ),
    neighborhoods: Object.freeze(neighborhoods),
    byId,
    neighborhoodOf,
    routes: Object.freeze(routes),
  });
}

/** Capture computed membership for durable storage through the snapshot validator. */
export function snapshotNeighborhoodIndex(
  index: NeighborhoodIndex,
  version: NeighborhoodSnapshotVersion,
): AtlasNeighborhoodSnapshot {
  return makeAtlasNeighborhoodSnapshot({
    ...version,
    layoutVersion: index.layoutVersion,
    capacity: index.capacity,
    entries: index.neighborhoods.map((value) => ({
      neighborhoodId: value.neighborhoodId,
      firstCreationOrdinal: value.firstCreationOrdinal,
      islandIds: value.islandIds,
    })),
  });
}

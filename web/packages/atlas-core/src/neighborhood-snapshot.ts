import type { IslandId, NeighborhoodId } from './ids.js';
import { islandId, neighborhoodId } from './ids.js';

export const ATLAS_NEIGHBORHOOD_SCHEMA_VERSION = 1 as const;

export type AtlasNeighborhoodReason = 'initial' | 'new-regions' | 'repartition' | 'migration';

export interface AtlasNeighborhoodMembership {
  readonly neighborhoodId: NeighborhoodId;
  /** Ordinal of the first region when this durable neighborhood identity was created. */
  readonly firstCreationOrdinal: number;
  readonly islandIds: readonly IslandId[];
}

/** JSON-safe durable membership authority. Semantic routes remain derived from confirmed edges. */
export interface AtlasNeighborhoodSnapshot {
  readonly schemaVersion: typeof ATLAS_NEIGHBORHOOD_SCHEMA_VERSION;
  readonly neighborhoodVersion: number;
  readonly previousNeighborhoodVersion: number | null;
  readonly layoutVersion: number;
  readonly capacity: number;
  readonly reason: AtlasNeighborhoodReason;
  readonly entries: readonly AtlasNeighborhoodMembership[];
}

export class AtlasNeighborhoodValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AtlasNeighborhoodValidationError';
  }
}

const recordOf = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AtlasNeighborhoodValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const safeInteger = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new AtlasNeighborhoodValidationError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
};

/** Decode untrusted storage data and reject ambiguous membership rather than choosing a winner. */
export function parseAtlasNeighborhoodSnapshot(value: unknown): AtlasNeighborhoodSnapshot {
  const raw = recordOf(value, 'neighborhood snapshot');
  if (raw['schemaVersion'] !== ATLAS_NEIGHBORHOOD_SCHEMA_VERSION) {
    throw new AtlasNeighborhoodValidationError(
      `neighborhood snapshot schemaVersion must be ${ATLAS_NEIGHBORHOOD_SCHEMA_VERSION}`,
    );
  }
  const neighborhoodVersion = safeInteger(raw['neighborhoodVersion'], 'neighborhoodVersion', 1);
  const previousRaw = raw['previousNeighborhoodVersion'];
  const previousNeighborhoodVersion = previousRaw === null
    ? null
    : safeInteger(previousRaw, 'previousNeighborhoodVersion', 1);
  if (previousNeighborhoodVersion !== null && previousNeighborhoodVersion >= neighborhoodVersion) {
    throw new AtlasNeighborhoodValidationError(
      'previousNeighborhoodVersion must be lower than neighborhoodVersion',
    );
  }
  const layoutVersion = safeInteger(raw['layoutVersion'], 'layoutVersion', 1);
  const capacity = safeInteger(raw['capacity'], 'capacity', 1);
  const reason = raw['reason'];
  if (
    reason !== 'initial' &&
    reason !== 'new-regions' &&
    reason !== 'repartition' &&
    reason !== 'migration'
  ) {
    throw new AtlasNeighborhoodValidationError('neighborhood snapshot reason is invalid');
  }
  if (!Array.isArray(raw['entries'])) {
    throw new AtlasNeighborhoodValidationError('neighborhood snapshot entries must be an array');
  }

  const neighborhoodIds = new Set<string>();
  const firstOrdinals = new Set<number>();
  const assignedIslands = new Set<string>();
  const entries = raw['entries'].map((value_, index) => {
    const entry = recordOf(value_, `entries[${index}]`);
    const idRaw = entry['neighborhoodId'];
    if (typeof idRaw !== 'string' || idRaw.length === 0) {
      throw new AtlasNeighborhoodValidationError(
        `entries[${index}].neighborhoodId must be a non-empty string`,
      );
    }
    if (neighborhoodIds.has(idRaw)) {
      throw new AtlasNeighborhoodValidationError(`duplicate neighborhoodId: ${idRaw}`);
    }
    neighborhoodIds.add(idRaw);
    const firstCreationOrdinal = safeInteger(
      entry['firstCreationOrdinal'],
      `entries[${index}].firstCreationOrdinal`,
    );
    if (firstOrdinals.has(firstCreationOrdinal)) {
      throw new AtlasNeighborhoodValidationError(
        `duplicate neighborhood firstCreationOrdinal: ${firstCreationOrdinal}`,
      );
    }
    firstOrdinals.add(firstCreationOrdinal);
    if (!Array.isArray(entry['islandIds']) || entry['islandIds'].length === 0) {
      throw new AtlasNeighborhoodValidationError(`entries[${index}].islandIds must be non-empty`);
    }
    if (entry['islandIds'].length > capacity) {
      throw new AtlasNeighborhoodValidationError(
        `entries[${index}].islandIds exceeds neighborhood capacity`,
      );
    }
    const islandIds = entry['islandIds'].map((rawIsland, islandIndex) => {
      if (typeof rawIsland !== 'string' || rawIsland.length === 0) {
        throw new AtlasNeighborhoodValidationError(
          `entries[${index}].islandIds[${islandIndex}] must be a non-empty string`,
        );
      }
      if (assignedIslands.has(rawIsland)) {
        throw new AtlasNeighborhoodValidationError(
          `island belongs to more than one neighborhood: ${rawIsland}`,
        );
      }
      assignedIslands.add(rawIsland);
      return islandId(rawIsland);
    });
    return Object.freeze({
      neighborhoodId: neighborhoodId(idRaw),
      firstCreationOrdinal,
      islandIds: Object.freeze(islandIds),
    });
  });
  entries.sort(
    (a, b) =>
      a.firstCreationOrdinal - b.firstCreationOrdinal ||
      (a.neighborhoodId < b.neighborhoodId ? -1 : a.neighborhoodId > b.neighborhoodId ? 1 : 0),
  );
  return Object.freeze({
    schemaVersion: ATLAS_NEIGHBORHOOD_SCHEMA_VERSION,
    neighborhoodVersion,
    previousNeighborhoodVersion,
    layoutVersion,
    capacity,
    reason,
    entries: Object.freeze(entries),
  });
}

export function makeAtlasNeighborhoodSnapshot(
  value: Omit<AtlasNeighborhoodSnapshot, 'schemaVersion'>,
): AtlasNeighborhoodSnapshot {
  return parseAtlasNeighborhoodSnapshot({
    ...value,
    schemaVersion: ATLAS_NEIGHBORHOOD_SCHEMA_VERSION,
  });
}

export interface NeighborhoodCoverage {
  readonly present: readonly IslandId[];
  readonly missing: readonly IslandId[];
  readonly stale: readonly IslandId[];
}

export function inspectNeighborhoodCoverage(
  snapshot: AtlasNeighborhoodSnapshot,
  graphIslandIds: readonly IslandId[],
): NeighborhoodCoverage {
  const graph = new Set(graphIslandIds);
  const stored = new Set(snapshot.entries.flatMap((entry) => entry.islandIds));
  return Object.freeze({
    present: Object.freeze(graphIslandIds.filter((id) => stored.has(id))),
    missing: Object.freeze(graphIslandIds.filter((id) => !stored.has(id))),
    stale: Object.freeze(
      snapshot.entries.flatMap((entry) => entry.islandIds).filter((id) => !graph.has(id)),
    ),
  });
}

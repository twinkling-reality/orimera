import type { IslandPlacement } from '../coords.js';
import { atlasVec3, placement } from '../coords.js';
import type { IslandId } from '../ids.js';
import { islandId } from '../ids.js';

export const ATLAS_LAYOUT_SCHEMA_VERSION = 1 as const;

export type AtlasLayoutReason = 'initial' | 'new-regions' | 'compaction' | 'migration';

export interface AtlasLayoutEntry {
  readonly islandId: IslandId;
  /** Unique and monotonic inside one workspace layout lineage. */
  readonly creationOrdinal: number;
  readonly placement: IslandPlacement;
}

/** JSON-safe durable authority. It contains presentation state and no capture-derived geometry. */
export interface AtlasLayoutSnapshot {
  readonly schemaVersion: typeof ATLAS_LAYOUT_SCHEMA_VERSION;
  readonly layoutVersion: number;
  readonly previousLayoutVersion: number | null;
  readonly reason: AtlasLayoutReason;
  readonly entries: readonly AtlasLayoutEntry[];
}

export class AtlasLayoutValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AtlasLayoutValidationError';
  }
}

const recordOf = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AtlasLayoutValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const safeInteger = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new AtlasLayoutValidationError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
};

const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AtlasLayoutValidationError(`${label} must be finite`);
  }
  return value;
};

function parsePlacement(value: unknown, label: string): IslandPlacement {
  const raw = recordOf(value, label);
  const positionRaw = recordOf(raw['position'], `${label}.position`);
  const scale = finite(raw['scale'], `${label}.scale`);
  if (scale <= 0 || scale > 1_000_000) {
    throw new AtlasLayoutValidationError(`${label}.scale must be > 0 and <= 1000000`);
  }
  return placement(
    atlasVec3(
      finite(positionRaw['x'], `${label}.position.x`),
      finite(positionRaw['y'], `${label}.position.y`),
      finite(positionRaw['z'], `${label}.position.z`),
    ),
    finite(raw['yaw'], `${label}.yaw`),
    scale,
  );
}

/** Decode untrusted storage or transport data into a frozen, internally consistent snapshot. */
export function parseAtlasLayoutSnapshot(value: unknown): AtlasLayoutSnapshot {
  const raw = recordOf(value, 'layout snapshot');
  if (raw['schemaVersion'] !== ATLAS_LAYOUT_SCHEMA_VERSION) {
    throw new AtlasLayoutValidationError(
      `layout snapshot schemaVersion must be ${ATLAS_LAYOUT_SCHEMA_VERSION}`,
    );
  }
  const layoutVersion = safeInteger(raw['layoutVersion'], 'layoutVersion', 1);
  const previousRaw = raw['previousLayoutVersion'];
  const previousLayoutVersion =
    previousRaw === null
      ? null
      : safeInteger(previousRaw, 'previousLayoutVersion', 1);
  if (previousLayoutVersion !== null && previousLayoutVersion >= layoutVersion) {
    throw new AtlasLayoutValidationError('previousLayoutVersion must be lower than layoutVersion');
  }
  const reason = raw['reason'];
  if (
    reason !== 'initial' &&
    reason !== 'new-regions' &&
    reason !== 'compaction' &&
    reason !== 'migration'
  ) {
    throw new AtlasLayoutValidationError('layout snapshot reason is invalid');
  }
  if (!Array.isArray(raw['entries'])) {
    throw new AtlasLayoutValidationError('layout snapshot entries must be an array');
  }

  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const entries: AtlasLayoutEntry[] = raw['entries'].map((value_, index) => {
    const entry = recordOf(value_, `entries[${index}]`);
    const idRaw = entry['islandId'];
    if (typeof idRaw !== 'string' || idRaw.length === 0) {
      throw new AtlasLayoutValidationError(`entries[${index}].islandId must be a non-empty string`);
    }
    if (ids.has(idRaw)) {
      throw new AtlasLayoutValidationError(`duplicate islandId in layout snapshot: ${idRaw}`);
    }
    ids.add(idRaw);
    const ordinal = safeInteger(entry['creationOrdinal'], `entries[${index}].creationOrdinal`);
    if (ordinals.has(ordinal)) {
      throw new AtlasLayoutValidationError(`duplicate creationOrdinal in layout snapshot: ${ordinal}`);
    }
    ordinals.add(ordinal);
    return Object.freeze({
      islandId: islandId(idRaw),
      creationOrdinal: ordinal,
      placement: parsePlacement(entry['placement'], `entries[${index}].placement`),
    });
  });
  entries.sort(
    (a, b) =>
      a.creationOrdinal - b.creationOrdinal ||
      (a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0),
  );
  return Object.freeze({
    schemaVersion: ATLAS_LAYOUT_SCHEMA_VERSION,
    layoutVersion,
    previousLayoutVersion,
    reason,
    entries: Object.freeze(entries),
  });
}

/** Typed construction takes the same validation path as untrusted transport data. */
export function makeAtlasLayoutSnapshot(
  value: Omit<AtlasLayoutSnapshot, 'schemaVersion'>,
): AtlasLayoutSnapshot {
  return parseAtlasLayoutSnapshot({ ...value, schemaVersion: ATLAS_LAYOUT_SCHEMA_VERSION });
}

export function layoutPlacements(
  snapshot: AtlasLayoutSnapshot,
): ReadonlyMap<IslandId, IslandPlacement> {
  return new Map(snapshot.entries.map((entry) => [entry.islandId, entry.placement] as const));
}

export function layoutCreationOrdinals(
  snapshot: AtlasLayoutSnapshot,
): ReadonlyMap<IslandId, number> {
  return new Map(snapshot.entries.map((entry) => [entry.islandId, entry.creationOrdinal] as const));
}

export function nextCreationOrdinal(snapshot: AtlasLayoutSnapshot): number {
  let highest = -1;
  for (const entry of snapshot.entries) highest = Math.max(highest, entry.creationOrdinal);
  if (highest >= Number.MAX_SAFE_INTEGER) {
    throw new AtlasLayoutValidationError('layout creation ordinals are exhausted');
  }
  return highest + 1;
}

export interface LayoutCoverage {
  readonly present: readonly IslandId[];
  readonly missing: readonly IslandId[];
  readonly stale: readonly IslandId[];
}

/** Compare a graph island set with the layout artifact without silently filling either side. */
export function inspectLayoutCoverage(
  snapshot: AtlasLayoutSnapshot,
  graphIslandIds: readonly IslandId[],
): LayoutCoverage {
  const graph = new Set(graphIslandIds);
  const stored = new Set(snapshot.entries.map((entry) => entry.islandId));
  const present = graphIslandIds.filter((id) => stored.has(id));
  const missing = graphIslandIds.filter((id) => !stored.has(id));
  const stale = snapshot.entries.map((entry) => entry.islandId).filter((id) => !graph.has(id));
  return Object.freeze({
    present: Object.freeze(present),
    missing: Object.freeze(missing),
    stale: Object.freeze(stale),
  });
}

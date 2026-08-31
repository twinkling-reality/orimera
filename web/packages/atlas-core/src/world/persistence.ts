import type { AtlasLayoutSnapshot } from '../layout/snapshot.js';
import type { AtlasNeighborhoodSnapshot } from '../neighborhood-snapshot.js';
import {
  ATLAS_COMPOSER_KEY,
  ATLAS_COMPOSER_VERSION,
  validateWorldTopology,
} from './composer.js';
import type { WorldModuleInstance, WorldTopologySnapshot } from './composer.js';

const SHA256 = /^[0-9a-f]{64}$/;

export type SpatialEvidenceBinding =
  | { readonly kind: 'span'; readonly span_id: string }
  | { readonly kind: 'missing'; readonly reason: string };

export interface SpatialDependency {
  readonly kind: 'evidence_span' | 'capture' | 'entity' | 'assertion';
  readonly ref: string;
  readonly element_id: string | null;
}

export interface SpatialAuthorityDraftOptions {
  readonly graphSha256: string;
  readonly reconstructionSha256: string;
  readonly layout: AtlasLayoutSnapshot;
  readonly neighborhood: AtlasNeighborhoodSnapshot;
  readonly evidenceBindings: ReadonlyMap<string, SpatialEvidenceBinding>;
  readonly dependencies?: readonly SpatialDependency[];
}

/**
 * Fixed-point, JSON-safe input for the backend authority. It intentionally carries no section
 * or snapshot digest: the backend canonicalizes, validates against live evidence, hashes, and
 * performs the protected compare-and-swap.
 */
export interface SpatialAuthorityCandidateDraft {
  readonly graph_sha256: string;
  readonly reconstruction_sha256: string;
  readonly composer_key: typeof ATLAS_COMPOSER_KEY;
  readonly composer_version: typeof ATLAS_COMPOSER_VERSION;
  readonly topology: Readonly<Record<string, unknown>>;
  readonly layout: Readonly<Record<string, unknown>>;
  readonly placement: Readonly<Record<string, unknown>>;
  readonly neighborhood: Readonly<Record<string, unknown>>;
}

function fixed(value: number, scale: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  const quantized = Math.round(value * scale);
  if (!Number.isSafeInteger(quantized)) throw new TypeError(`${label} exceeds fixed-point range`);
  return quantized;
}

function collision(instance: WorldModuleInstance): Readonly<Record<string, unknown>> {
  const value = instance.collision;
  if (value.kind === 'none') return Object.freeze({ kind: 'none' });
  if (value.kind === 'circle') {
    return Object.freeze({ kind: 'circle', radius_mm: fixed(value.radius, 1_000, 'collision radius') });
  }
  return Object.freeze({
    kind: 'box',
    half_width_mm: fixed(value.halfWidth, 1_000, 'collision half width'),
    half_depth_mm: fixed(value.halfDepth, 1_000, 'collision half depth'),
  });
}

function evidence(
  instance: WorldModuleInstance,
  bindings: ReadonlyMap<string, SpatialEvidenceBinding>,
): Readonly<Record<string, unknown>> {
  if (instance.evidence !== 'source-evidence') return Object.freeze({ kind: 'none' });
  const binding = bindings.get(instance.instanceId);
  if (binding === undefined) {
    throw new TypeError(`source-evidence element needs an explicit span or missing reason: ${instance.instanceId}`);
  }
  if (binding.kind === 'missing' && binding.reason.trim().length === 0) {
    throw new TypeError(`missing evidence reason is empty: ${instance.instanceId}`);
  }
  return Object.freeze({ ...binding });
}

function owner(instance: WorldModuleInstance): Readonly<Record<string, string>> {
  return Object.freeze({
    kind: instance.provenance.owner.kind,
    id: instance.provenance.owner.id,
  });
}

function dependencyKey(value: SpatialDependency): string {
  return `${value.kind}\u0000${value.ref}\u0000${value.element_id ?? ''}`;
}

/** Convert a validated composer draft plus its exact input snapshots into backend authority input. */
export function toSpatialAuthorityCandidateDraft(
  snapshot: WorldTopologySnapshot,
  options: SpatialAuthorityDraftOptions,
): SpatialAuthorityCandidateDraft {
  validateWorldTopology(snapshot);
  if (!SHA256.test(options.graphSha256) || !SHA256.test(options.reconstructionSha256)) {
    throw new TypeError('graph and reconstruction identities must be lowercase SHA-256 digests');
  }
  if (
    options.layout.layoutVersion !== snapshot.layoutVersion ||
    options.neighborhood.layoutVersion !== snapshot.layoutVersion
  ) {
    throw new TypeError('layout, neighborhood, and composer draft versions must agree');
  }
  const composedRegions = new Set<string>(
    snapshot.instances
      .filter((value) => value.provenance.owner.kind === 'region')
      .map((value) => String(value.provenance.owner.id)),
  );
  const layoutRegions = new Set<string>(options.layout.entries.map((value) => String(value.islandId)));
  const neighborhoodRegions = new Set<string>(
    options.neighborhood.entries.flatMap((value) => value.islandIds.map(String)),
  );
  for (const region of composedRegions) {
    if (!layoutRegions.has(region) || !neighborhoodRegions.has(region)) {
      throw new TypeError(`region is absent from a protected layout or neighborhood: ${region}`);
    }
  }
  if (layoutRegions.size !== composedRegions.size || neighborhoodRegions.size !== composedRegions.size) {
    throw new TypeError('layout and neighborhood must exactly cover composed regions');
  }

  const dependencies = [...(options.dependencies ?? [])].sort((a, b) =>
    dependencyKey(a).localeCompare(dependencyKey(b)),
  );
  const topology = Object.freeze({
    schema_version: 1,
    world_id: snapshot.worldId,
    regions: Object.freeze(
      [...composedRegions].sort().map((region_id) => Object.freeze({ region_id })),
    ),
    elements: Object.freeze(snapshot.instances.map((instance) => Object.freeze({
      element_id: instance.instanceId,
      owner: owner(instance),
      module: Object.freeze({
        key: instance.moduleKey,
        version: instance.moduleVersion,
        requested_key: instance.requestedModuleKey,
      }),
      lineage: Object.freeze({
        recipe_key: instance.recipeKey,
        recipe_version: instance.recipeVersion,
        slot_key: instance.slotKey,
      }),
      collision: collision(instance),
      evidence: evidence(instance, options.evidenceBindings),
      attachment: instance.attachment === null
        ? null
        : Object.freeze({
          parent_element_id: instance.attachment.parentInstanceId,
          socket_key: instance.attachment.socketKey,
        }),
      streaming_key: instance.streamingKey,
    }))),
    navigation: Object.freeze({
      agent_radius_mm: fixed(snapshot.navigation.cameraRadius, 1_000, 'agent radius'),
      maximum_slope_millidegrees: fixed(
        snapshot.navigation.maximumSlopeDegrees,
        1_000,
        'maximum slope',
      ),
      destinations: Object.freeze([...snapshot.navigation.destinations]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((value) => Object.freeze({
          destination_id: value.id,
          region_id: value.islandId,
          required: value.required,
        }))),
      edges: Object.freeze([...snapshot.navigation.edges]
        .sort((a, b) =>
          a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
        .map((value) => Object.freeze({
          from: value.from,
          to: value.to,
          kind: value.kind,
          max_slope_millidegrees: fixed(value.maxSlopeDegrees, 1_000, 'edge slope'),
        }))),
    }),
    dependencies: Object.freeze(dependencies.map((value) => Object.freeze({ ...value }))),
  });
  const layout = Object.freeze({
    schema_version: 1,
    layout_version: options.layout.layoutVersion,
    regions: Object.freeze([...options.layout.entries]
      .sort((a, b) => a.creationOrdinal - b.creationOrdinal || a.islandId.localeCompare(b.islandId))
      .map((value) => Object.freeze({
        region_id: value.islandId,
        creation_ordinal: value.creationOrdinal,
      }))),
  });
  const placement = Object.freeze({
    schema_version: 1,
    coordinate_unit: 'millimetre',
    elements: Object.freeze(snapshot.instances.map((value) => Object.freeze({
      element_id: value.instanceId,
      x_mm: fixed(value.transform.position.x, 1_000, 'element x'),
      y_mm: fixed(value.transform.position.y, 1_000, 'element y'),
      z_mm: fixed(value.transform.position.z, 1_000, 'element z'),
      yaw_microradians: fixed(value.transform.yaw, 1_000_000, 'element yaw'),
      scale_milli: fixed(value.transform.scale, 1_000, 'element scale'),
    }))),
    destinations: Object.freeze([...snapshot.navigation.destinations]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((value) => Object.freeze({
        destination_id: value.id,
        x_mm: fixed(value.position.x, 1_000, 'destination x'),
        y_mm: fixed(value.position.y, 1_000, 'destination y'),
        z_mm: fixed(value.position.z, 1_000, 'destination z'),
      }))),
  });
  const neighborhood = Object.freeze({
    schema_version: 1,
    neighborhood_version: options.neighborhood.neighborhoodVersion,
    layout_version: options.neighborhood.layoutVersion,
    neighborhoods: Object.freeze([...options.neighborhood.entries]
      .sort((a, b) => a.neighborhoodId.localeCompare(b.neighborhoodId))
      .map((value) => Object.freeze({
        neighborhood_id: value.neighborhoodId,
        region_ids: Object.freeze([...value.islandIds].sort()),
      }))),
  });
  return Object.freeze({
    graph_sha256: options.graphSha256,
    reconstruction_sha256: options.reconstructionSha256,
    composer_key: ATLAS_COMPOSER_KEY,
    composer_version: ATLAS_COMPOSER_VERSION,
    topology,
    layout,
    placement,
    neighborhood,
  });
}

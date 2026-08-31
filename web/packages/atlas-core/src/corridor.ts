import type { IslandPlacement } from './coords.js';
import { localDirectionToAtlas, localToAtlas, localVec3 } from './coords.js';
import type { CorridorRule } from './navigation.js';

export interface CorridorArtifactWire {
  readonly profile: 'orimera.corridor-artifact/v1';
  readonly manifest_digest: string;
  readonly reconstruction_digest: string;
  readonly topology_digest: string;
  readonly centreline: readonly (readonly [number, number, number])[];
  readonly lateral_half_widths: readonly number[];
  readonly collision_proxy: {
    readonly clearance_radii_metres: readonly number[];
    readonly agent_radius_metres: number;
  };
  readonly navigation_surface: { readonly slope_degrees: readonly number[] };
  readonly forwards: readonly (readonly [number, number, number])[];
  readonly look_envelope_degrees: {
    readonly maximum_yaw: number;
    readonly minimum_pitch: number;
    readonly maximum_pitch: number;
  };
  readonly required_destinations: readonly {
    readonly destination_ref: string;
    readonly centreline_index: number;
  }[];
  readonly source_vantage_indices: readonly number[];
  readonly recovery_pose_indices: readonly number[];
  readonly accepted: boolean;
  readonly published_rung: 2 | 3;
  readonly reasons: readonly string[];
  readonly sha256: string;
}

export interface ValidatedCorridorRule extends CorridorRule {
  readonly reconstructionDigest: string;
  readonly topologyDigest: string;
  readonly artifactDigest: string;
  readonly lookYawCentres: readonly number[];
  readonly maximumLookYawRadians: number;
  readonly minimumLookPitchRadians: number;
  readonly maximumLookPitchRadians: number;
}

function finiteVector(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Consume an already content-addressed corridor without granting more movement than it records.
 *
 * Cryptographic byte verification belongs to the authenticated asset loader. This adapter checks
 * the artifact's protected base digests and complete shape, then deliberately selects the smallest
 * measured lateral width. It can make navigation more conservative; it cannot expand the envelope.
 */
export function corridorRuleFromArtifact(
  value: CorridorArtifactWire,
  placement: IslandPlacement,
  expected: { readonly reconstructionDigest: string; readonly topologyDigest: string },
): ValidatedCorridorRule {
  if (value.profile !== 'orimera.corridor-artifact/v1' || !digest(value.sha256)) {
    throw new Error('unsupported or unaddressed corridor artifact');
  }
  if (value.reconstruction_digest !== expected.reconstructionDigest) {
    throw new Error('corridor artifact is stale against reconstruction');
  }
  if (value.topology_digest !== expected.topologyDigest) {
    throw new Error('corridor artifact is stale against topology');
  }
  if (!value.accepted || value.published_rung !== 2 || value.reasons.length > 0) {
    throw new Error('a failed corridor artifact cannot publish rung 2');
  }
  const count = value.centreline.length;
  if (count < 2 || value.lateral_half_widths.length !== count || value.forwards.length !== count ||
      value.collision_proxy.clearance_radii_metres.length !== count ||
      value.navigation_surface.slope_degrees.length !== count) {
    throw new Error('corridor arrays do not describe the same measured poses');
  }
  if (!value.centreline.every(finiteVector) || !value.forwards.every(finiteVector)) {
    throw new Error('corridor poses must be finite three-vectors');
  }
  if (!value.lateral_half_widths.every((item) => Number.isFinite(item) && item >= 0)) {
    throw new Error('corridor widths must be finite and non-negative');
  }
  if (!Number.isFinite(value.collision_proxy.agent_radius_metres) ||
      value.collision_proxy.agent_radius_metres <= 0 ||
      !value.collision_proxy.clearance_radii_metres.every((item) =>
        Number.isFinite(item) && item >= value.collision_proxy.agent_radius_metres)) {
    throw new Error('corridor collision proxy is invalid for the agent radius');
  }
  const look = value.look_envelope_degrees;
  if (!Number.isFinite(look.maximum_yaw) || look.maximum_yaw <= 0 || look.maximum_yaw > 180 ||
      !Number.isFinite(look.minimum_pitch) || !Number.isFinite(look.maximum_pitch) ||
      look.minimum_pitch < -89 || look.maximum_pitch > 89 ||
      look.minimum_pitch > look.maximum_pitch) {
    throw new Error('corridor look envelope is invalid');
  }
  const centreline = value.centreline.map((position) =>
    localToAtlas(placement, localVec3(position[0], position[1], position[2])));
  const lookYawCentres = value.forwards.map((forward) => {
    const atlas = localDirectionToAtlas(placement, localVec3(forward[0], forward[1], forward[2]));
    return Math.atan2(-atlas.x, -atlas.z);
  });
  return Object.freeze({
    movement: 'corridor',
    centreline: Object.freeze(centreline),
    // Uniform minimum is intentionally conservative. A later segment-aware resolver may recover
    // the recorded per-node width, but no consumer is permitted to choose the maximum.
    halfWidth: Math.min(...value.lateral_half_widths) * placement.scale,
    reconstructionDigest: value.reconstruction_digest,
    topologyDigest: value.topology_digest,
    artifactDigest: value.sha256,
    lookYawCentres: Object.freeze(lookYawCentres),
    maximumLookYawRadians: look.maximum_yaw * Math.PI / 180,
    minimumLookPitchRadians: look.minimum_pitch * Math.PI / 180,
    maximumLookPitchRadians: look.maximum_pitch * Math.PI / 180,
  });
}

function angularDelta(value: number, centre: number): number {
  return Math.atan2(Math.sin(value - centre), Math.cos(value - centre));
}

/** Clamp camera look to one measured pose's recorded envelope. */
export function constrainCorridorLook(
  rule: ValidatedCorridorRule,
  centrelineIndex: number,
  desiredYaw: number,
  desiredPitch: number,
): { readonly yaw: number; readonly pitch: number } {
  const index = Math.max(0, Math.min(rule.lookYawCentres.length - 1, centrelineIndex));
  const centre = rule.lookYawCentres[index]!;
  const delta = angularDelta(desiredYaw, centre);
  const yaw = centre + Math.max(-rule.maximumLookYawRadians, Math.min(rule.maximumLookYawRadians, delta));
  const pitch = Math.max(
    rule.minimumLookPitchRadians,
    Math.min(rule.maximumLookPitchRadians, desiredPitch),
  );
  return Object.freeze({ yaw, pitch });
}

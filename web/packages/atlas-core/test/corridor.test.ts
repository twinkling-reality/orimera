import { describe, expect, it } from 'vitest';
import {
  atlasVec3,
  constrainCorridorLook,
  constrainRegionTraversal,
  corridorRuleFromArtifact,
  placement,
  type CorridorArtifactWire,
} from '../src/index.js';

const artifact = (changes: Partial<CorridorArtifactWire> = {}): CorridorArtifactWire => ({
  profile: 'exulanica.corridor-artifact/v1',
  manifest_digest: '1'.repeat(64),
  reconstruction_digest: '2'.repeat(64),
  topology_digest: '3'.repeat(64),
  centreline: [[0, 0, 0], [10, 0, 0], [20, 0, 0]],
  lateral_half_widths: [0.8, 0.45, 0.7],
  collision_proxy: { clearance_radii_metres: [1.1, 0.75, 1], agent_radius_metres: 0.3 },
  navigation_surface: { slope_degrees: [2, 3, 2] },
  forwards: [[1, 0, 0], [1, 0, 0], [1, 0, 0]],
  look_envelope_degrees: { maximum_yaw: 30, minimum_pitch: -20, maximum_pitch: 35 },
  required_destinations: [{ destination_ref: 'end', centreline_index: 2 }],
  source_vantage_indices: [0],
  recovery_pose_indices: [0],
  accepted: true,
  published_rung: 2,
  reasons: [],
  sha256: '4'.repeat(64),
  ...changes,
});

const expected = {
  reconstructionDigest: '2'.repeat(64),
  topologyDigest: '3'.repeat(64),
};

describe('a validated rung-2 corridor', () => {
  it('uses the narrowest measured width and cannot expand the artifact envelope', () => {
    const rule = corridorRuleFromArtifact(
      artifact(),
      placement(atlasVec3(0, 0, 0), 0, 2),
      expected,
    );
    expect(rule.halfWidth).toBeCloseTo(0.9);
    const resolved = constrainRegionTraversal(
      rule,
      atlasVec3(2, 1.62, 0),
      atlasVec3(5, 1.62, 8),
    );
    expect(resolved.z).toBeCloseTo(0.9);
  });

  it('clamps look relative to a measured camera rather than the renderer global limit', () => {
    const rule = corridorRuleFromArtifact(
      artifact(),
      placement(atlasVec3(0, 0, 0), 0, 1),
      expected,
    );
    const resolved = constrainCorridorLook(rule, 1, rule.lookYawCentres[1]! + Math.PI, Math.PI / 2);
    expect(Math.abs(resolved.yaw - rule.lookYawCentres[1]!)).toBeCloseTo(Math.PI / 6);
    expect(resolved.pitch).toBeCloseTo(35 * Math.PI / 180);
  });

  it('refuses stale, failed, or malformed artifacts instead of falling open', () => {
    expect(() => corridorRuleFromArtifact(
      artifact(),
      placement(atlasVec3(0, 0, 0), 0, 1),
      { ...expected, topologyDigest: '9'.repeat(64) },
    )).toThrow(/stale/);
    expect(() => corridorRuleFromArtifact(
      artifact({ accepted: false, published_rung: 3, reasons: ['clearance'] }),
      placement(atlasVec3(0, 0, 0), 0, 1),
      expected,
    )).toThrow(/cannot publish/);
  });
});

import type { WorldStyleParameterDefinition } from '@orimera/atlas-core';

export interface WorldStyleCapability {
  readonly capability: string;
  readonly kind: WorldStyleParameterDefinition['kind'];
  readonly group: WorldStyleParameterDefinition['group'];
  readonly min?: number;
  readonly max?: number;
}

/**
 * Runtime-safe renderer vocabulary. An AI-authored manifest may select, rename, group, and narrow
 * these controls, but it may not invent an executable binding or widen a protected range.
 */
export const WORLD_STYLE_CAPABILITIES: Readonly<Record<string, WorldStyleCapability>> = Object.freeze({
  'world.vitality': Object.freeze({ capability: 'world.vitality', kind: 'range', group: 'world', min: 0, max: 1 }),
  'material.transmission': Object.freeze({ capability: 'material.transmission', kind: 'range', group: 'material', min: 0, max: 1 }),
  'relationships.energy': Object.freeze({ capability: 'relationships.energy', kind: 'range', group: 'motion', min: 0, max: 1 }),
  'detail.ecology': Object.freeze({ capability: 'detail.ecology', kind: 'range', group: 'detail', min: 0, max: 1 }),
  'atmosphere.softness': Object.freeze({ capability: 'atmosphere.softness', kind: 'range', group: 'atmosphere', min: 0, max: 1 }),
  'detail.contours': Object.freeze({ capability: 'detail.contours', kind: 'range', group: 'detail', min: 0, max: 1 }),
  'material.technical-contrast': Object.freeze({ capability: 'material.technical-contrast', kind: 'range', group: 'material', min: 0, max: 1 }),
});

export interface WorldStyleManifestIssue {
  readonly key: string;
  readonly detail: string;
}

/** Validate untrusted model output before it becomes a catalog descriptor or a generated form. */
export function validateWorldStyleControlManifest(
  controls: readonly WorldStyleParameterDefinition[],
): readonly WorldStyleManifestIssue[] {
  const issues: WorldStyleManifestIssue[] = [];
  const keys = new Set<string>();
  for (const control of controls) {
    if (keys.has(control.key)) {
      issues.push(Object.freeze({ key: control.key, detail: 'Control keys must be unique within a style.' }));
      continue;
    }
    keys.add(control.key);
    const capability = WORLD_STYLE_CAPABILITIES[control.capability];
    if (capability === undefined) {
      issues.push(Object.freeze({
        key: control.key,
        detail: `Unsupported renderer capability: ${control.capability}.`,
      }));
      continue;
    }
    if (control.kind !== capability.kind || control.group !== capability.group) {
      issues.push(Object.freeze({
        key: control.key,
        detail: `Control kind/group does not match ${control.capability}.`,
      }));
      continue;
    }
    if (
      control.kind === 'range' &&
      (control.min < (capability.min ?? control.min) || control.max > (capability.max ?? control.max))
    ) {
      issues.push(Object.freeze({
        key: control.key,
        detail: `Control range exceeds the safe ${control.capability} capability range.`,
      }));
    }
  }
  return Object.freeze(issues);
}

export function assertWorldStyleControlManifest(
  controls: readonly WorldStyleParameterDefinition[],
): readonly WorldStyleParameterDefinition[] {
  const issues = validateWorldStyleControlManifest(controls);
  if (issues.length > 0) throw new TypeError(issues.map((issue) => `${issue.key}: ${issue.detail}`).join(' '));
  return controls;
}

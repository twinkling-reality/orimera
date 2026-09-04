import type { WorldStyleParameterDefinition } from '@exulanica/atlas-core';

export interface WorldStyleCapability {
  readonly capability: string;
  readonly kind: WorldStyleParameterDefinition['kind'];
  readonly group: WorldStyleParameterDefinition['group'];
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
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
  'surface.finish': Object.freeze({
    capability: 'surface.finish', kind: 'choice', group: 'material',
    options: Object.freeze(['source-paper', 'clear-lens']),
  }),
  'motion.tempo': Object.freeze({ capability: 'motion.tempo', kind: 'range', group: 'motion', min: 0.75, max: 1.25 }),
  /*
   * The interface's own colour, as four bounded numbers.
   *
   * These exist so that a palette read out of a person's photographs can enter the world through
   * the same door as every other style change. The customization contract lets a proposal carry
   * registered capability values and nothing else, so "take the colour from my library" cannot be
   * five hex codes injected past validation; it has to be a reading expressed in the vocabulary
   * the registry already enforces. That constraint turned out to be the better product too: what
   * the photographs suggest arrives as slider positions the person can then move.
   *
   * `hue` is the full circle normalised to 0..1. The other three are bounded registers, not raw
   * colours, so no value here can produce an interface that fails contrast.
   */
  'interface.hue': Object.freeze({ capability: 'interface.hue', kind: 'range', group: 'world', min: 0, max: 1 }),
  'interface.warmth': Object.freeze({ capability: 'interface.warmth', kind: 'range', group: 'world', min: 0, max: 1 }),
  'interface.depth': Object.freeze({ capability: 'interface.depth', kind: 'range', group: 'world', min: 0, max: 1 }),
  'interface.light': Object.freeze({ capability: 'interface.light', kind: 'range', group: 'world', min: 0, max: 1 }),
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
  const boundCapabilities = new Set<string>();
  for (const control of controls) {
    if (keys.has(control.key)) {
      issues.push(Object.freeze({ key: control.key, detail: 'Control keys must be unique within a style.' }));
      continue;
    }
    keys.add(control.key);
    if (!/^[a-z][a-z0-9-]*$/.test(control.key)) {
      issues.push(Object.freeze({ key: control.key, detail: 'Control keys must be stable kebab-case IDs.' }));
    }
    if (control.label.trim().length === 0 || control.description.trim().length === 0) {
      issues.push(Object.freeze({ key: control.key, detail: 'Controls require a label and explanation.' }));
    }
    if (boundCapabilities.has(control.capability)) {
      issues.push(Object.freeze({
        key: control.key,
        detail: `Capability ${control.capability} may be bound only once within a style.`,
      }));
    }
    boundCapabilities.add(control.capability);
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
    if (
      control.kind === 'range' &&
      (
        !Number.isFinite(control.min) || !Number.isFinite(control.max) ||
        !Number.isFinite(control.step) || !Number.isFinite(control.defaultValue) ||
        control.min >= control.max || control.step <= 0 || control.step > control.max - control.min ||
        control.defaultValue < control.min || control.defaultValue > control.max
      )
    ) {
      issues.push(Object.freeze({
        key: control.key,
        detail: 'Range bounds, step, and default must be finite and internally consistent.',
      }));
    }
    if (
      control.kind === 'choice' && capability.options !== undefined &&
      control.options.some((option) => !capability.options!.includes(option.value))
    ) {
      issues.push(Object.freeze({
        key: control.key,
        detail: `Control options exceed the registered ${control.capability} values.`,
      }));
    }
    if (control.kind === 'choice') {
      const values = control.options.map((option) => option.value);
      if (
        values.length === 0 || new Set(values).size !== values.length ||
        control.options.some((option) => option.value.length === 0 || option.label.trim().length === 0) ||
        !values.includes(control.defaultValue)
      ) {
        issues.push(Object.freeze({
          key: control.key,
          detail: 'Choice values must be unique, labeled, and include the default.',
        }));
      }
    }
    if (control.kind === 'color' && !/^#[0-9a-f]{6}$/i.test(control.defaultValue)) {
      issues.push(Object.freeze({ key: control.key, detail: 'Color defaults must use six-digit hex.' }));
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

/**
 * Versioned Companion appearance data. Visual identity is a device preference, never graph fact.
 *
 * Version three replaces the rejected humanoid primitive with the verified geometric-avatar
 * grammar used by Grok Bot and documented by the MIT-licensed Bloub reference implementation:
 * one silhouette and two slit eyes, with no torso, limbs, mouth, antenna, halo, or 3D renderer.
 */
export type CompanionOperationalState =
  | 'resting'
  | 'attending'
  | 'uncertain'
  | 'working'
  | 'settled';

export type CompanionBodyVariant =
  | 'circle'
  | 'pebble'
  | 'squircle'
  | 'capsule'
  | 'cloud'
  | 'droplet';
export type CompanionColorVariant = 'ink' | 'rose' | 'orange' | 'periwinkle' | 'mint';
export type CompanionFaceVariant = 'neutral' | 'attentive' | 'curious' | 'happy' | 'sleepy';

export interface CompanionAppearanceConfigurationV3 {
  readonly companionModelVersion: 3;
  readonly bodyVariant: CompanionBodyVariant;
  readonly colorVariant: CompanionColorVariant;
  readonly faceVariant: CompanionFaceVariant;
  readonly bodyColor: string;
  readonly eyeColor: string;
  readonly motionProfile: 'gaze-and-blink';
  readonly reducedMotionProfile: 'still-expression';
}

export type CompanionAppearanceConfiguration = CompanionAppearanceConfigurationV3;

const BODY = new Set<CompanionBodyVariant>([
  'circle', 'pebble', 'squircle', 'capsule', 'cloud', 'droplet',
]);
const COLOR = new Set<CompanionColorVariant>([
  'ink', 'rose', 'orange', 'periwinkle', 'mint',
]);
const FACE = new Set<CompanionFaceVariant>([
  'neutral', 'attentive', 'curious', 'happy', 'sleepy',
]);
const COLORS: Readonly<Record<CompanionColorVariant, readonly [string, string]>> = Object.freeze({
  ink: ['#0a0a0c', '#f7f5ef'],
  rose: ['#f13f8e', '#28101b'],
  orange: ['#ff8a35', '#2b1405'],
  periwinkle: ['#637ff2', '#0c1747'],
  mint: ['#43caa9', '#062a25'],
});

export interface CompanionAppearanceSelection {
  readonly body: CompanionBodyVariant;
  readonly color: CompanionColorVariant;
  readonly face: CompanionFaceVariant;
}

export function companionAppearanceConfiguration(
  selection: CompanionAppearanceSelection,
): CompanionAppearanceConfiguration {
  const [bodyColor, eyeColor] = COLORS[selection.color];
  return Object.freeze({
    companionModelVersion: 3,
    bodyVariant: selection.body,
    colorVariant: selection.color,
    faceVariant: selection.face,
    bodyColor,
    eyeColor,
    motionProfile: 'gaze-and-blink',
    reducedMotionProfile: 'still-expression',
  });
}

/** Pink circle is the selected avatar shown in the supplied Grok Bot reference crop. */
export const DEFAULT_COMPANION = companionAppearanceConfiguration({
  body: 'circle',
  color: 'rose',
  face: 'neutral',
});

/** Compatibility names for callers that persisted the earlier native experiment. */
export const DEFAULT_NATIVE_COMPANION = DEFAULT_COMPANION;
export const NATIVE_COMPANION_PROTOTYPE = DEFAULT_COMPANION;

export interface CompanionAppearanceResolution {
  readonly configuration: CompanionAppearanceConfiguration;
  readonly issues: readonly string[];
}

export function resolveCompanionAppearance(value: unknown): CompanionAppearanceResolution {
  if (typeof value !== 'object' || value === null) {
    return { configuration: DEFAULT_COMPANION, issues: ['configuration-not-an-object'] };
  }
  const record = value as Record<string, unknown>;
  if (record['companionModelVersion'] === 1 || record['companionModelVersion'] === 2) {
    return { configuration: DEFAULT_COMPANION, issues: ['migrated-rejected-prototype'] };
  }
  if (record['companionModelVersion'] !== 3) {
    return { configuration: DEFAULT_COMPANION, issues: ['unsupported-model-version'] };
  }
  const body = record['bodyVariant'] as CompanionBodyVariant;
  const color = record['colorVariant'] as CompanionColorVariant;
  const face = record['faceVariant'] as CompanionFaceVariant;
  if (!BODY.has(body) || !COLOR.has(color) || !FACE.has(face)) {
    return { configuration: DEFAULT_COMPANION, issues: ['invalid-v3-configuration'] };
  }
  return {
    configuration: companionAppearanceConfiguration({ body, color, face }),
    issues: [],
  };
}

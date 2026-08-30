/** Versioned device preferences. The authored Atlas landscape is not a theme picker. */

import {
  resolveWorldStyleParameters,
  type WorldArtProfileId,
  type WorldStyleParameters,
} from '@orimera/presentation';

export const PREFERENCES_KEY = 'orimera.atlas.preferences.v1';

export type AppearancePreference = 'dawn';
export type ContrastPreference = 'standard' | 'high';
export type TransparencyPreference = 'layered' | 'reduced';
export type VignettePreference = 'off' | 'subtle' | 'strong';
export type TurnPreference = 'smooth' | 'snap';
export type TransitionPreference = 'system' | 'motion' | 'fade';
export type CompanionInitiativePreference = 'normal' | 'minimal' | 'off';

export interface AtlasPreferences {
  readonly version: 1;
  readonly appearance: AppearancePreference;
  readonly contrast: ContrastPreference;
  readonly transparency: TransparencyPreference;
  readonly worldArtProfile: WorldArtProfileId;
  readonly worldStyleParameters: WorldStyleParameters;
  readonly fieldOfView: number;
  /** Multiplier over the measured default rather than engine units exposed as a user setting. */
  readonly mouseSensitivity: number;
  readonly vignette: VignettePreference;
  readonly cameraBob: boolean;
  readonly turnMode: TurnPreference;
  readonly transition: TransitionPreference;
  readonly companionInitiative: CompanionInitiativePreference;
  readonly companionSide: 'left' | 'right';
}

export const DEFAULT_PREFERENCES: AtlasPreferences = Object.freeze({
  version: 1,
  appearance: 'dawn',
  contrast: 'standard',
  transparency: 'layered',
  worldArtProfile: 'origin-landscape',
  worldStyleParameters: resolveWorldStyleParameters('origin-landscape'),
  fieldOfView: 70,
  mouseSensitivity: 1,
  vignette: 'subtle',
  cameraBob: false,
  turnMode: 'smooth',
  transition: 'system',
  companionInitiative: 'normal',
  companionSide: 'right',
});

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const APPEARANCE = new Set<AppearancePreference>(['dawn']);
const CONTRAST = new Set<ContrastPreference>(['standard', 'high']);
const TRANSPARENCY = new Set<TransparencyPreference>(['layered', 'reduced']);
// Alternate profiles remain renderer test fixtures. Stored legacy choices return to the one
// authored product identity instead of silently keeping an abandoned experimental treatment.
const WORLD_ART_PROFILE = new Set<WorldArtProfileId>(['origin-landscape']);
const VIGNETTE = new Set<VignettePreference>(['off', 'subtle', 'strong']);
const TURN = new Set<TurnPreference>(['smooth', 'snap']);
const TRANSITION = new Set<TransitionPreference>(['system', 'motion', 'fade']);
const INITIATIVE = new Set<CompanionInitiativePreference>(['normal', 'minimal', 'off']);

const finiteIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Invalid or newer data falls back field by field; one bad value never bricks the menu. */
export function normalisePreferences(value: unknown): AtlasPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return Object.freeze({
    version: 1,
    appearance: APPEARANCE.has(record['appearance'] as AppearancePreference)
      ? (record['appearance'] as AppearancePreference)
      : DEFAULT_PREFERENCES.appearance,
    contrast: CONTRAST.has(record['contrast'] as ContrastPreference)
      ? (record['contrast'] as ContrastPreference)
      : DEFAULT_PREFERENCES.contrast,
    transparency: TRANSPARENCY.has(record['transparency'] as TransparencyPreference)
      ? (record['transparency'] as TransparencyPreference)
      : DEFAULT_PREFERENCES.transparency,
    worldArtProfile: WORLD_ART_PROFILE.has(record['worldArtProfile'] as WorldArtProfileId)
      ? (record['worldArtProfile'] as WorldArtProfileId)
      : DEFAULT_PREFERENCES.worldArtProfile,
    worldStyleParameters: resolveWorldStyleParameters(
      WORLD_ART_PROFILE.has(record['worldArtProfile'] as WorldArtProfileId)
        ? (record['worldArtProfile'] as WorldArtProfileId)
        : DEFAULT_PREFERENCES.worldArtProfile,
      typeof record['worldStyleParameters'] === 'object' && record['worldStyleParameters'] !== null
        ? (record['worldStyleParameters'] as Readonly<Record<string, unknown>>)
        : {},
    ),
    fieldOfView: finiteIn(record['fieldOfView'], 60, 90)
      ? record['fieldOfView']
      : DEFAULT_PREFERENCES.fieldOfView,
    mouseSensitivity: finiteIn(record['mouseSensitivity'], 0.5, 2)
      ? record['mouseSensitivity']
      : DEFAULT_PREFERENCES.mouseSensitivity,
    vignette: VIGNETTE.has(record['vignette'] as VignettePreference)
      ? (record['vignette'] as VignettePreference)
      : DEFAULT_PREFERENCES.vignette,
    cameraBob:
      typeof record['cameraBob'] === 'boolean'
        ? record['cameraBob']
        : DEFAULT_PREFERENCES.cameraBob,
    turnMode: TURN.has(record['turnMode'] as TurnPreference)
      ? (record['turnMode'] as TurnPreference)
      : DEFAULT_PREFERENCES.turnMode,
    transition: TRANSITION.has(record['transition'] as TransitionPreference)
      ? (record['transition'] as TransitionPreference)
      : DEFAULT_PREFERENCES.transition,
    companionInitiative: INITIATIVE.has(
      record['companionInitiative'] as CompanionInitiativePreference,
    )
      ? (record['companionInitiative'] as CompanionInitiativePreference)
      : DEFAULT_PREFERENCES.companionInitiative,
    companionSide:
      record['companionSide'] === 'left' || record['companionSide'] === 'right'
        ? record['companionSide']
        : DEFAULT_PREFERENCES.companionSide,
  });
}

export function readPreferences(storage: PreferenceStorage): AtlasPreferences {
  try {
    const encoded = storage.getItem(PREFERENCES_KEY);
    return encoded === null ? DEFAULT_PREFERENCES : normalisePreferences(JSON.parse(encoded));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function writePreferences(storage: PreferenceStorage, value: AtlasPreferences): void {
  storage.setItem(PREFERENCES_KEY, JSON.stringify(normalisePreferences(value)));
}

export function resolvedAppearance(
  preference: AppearancePreference,
  _systemDark: boolean,
): AppearancePreference {
  return preference;
}

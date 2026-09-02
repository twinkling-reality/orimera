import { describe, expect, it } from 'vitest';
import { worldStyleControls } from '@orimera/presentation';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  normalisePreferences,
  readPreferences,
  resolvedAppearance,
  writePreferences,
} from '../src/preferences.js';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('Atlas preferences', () => {
  it('uses the authored daylight landscape when nothing was stored', () => {
    expect(readPreferences(new MemoryStorage())).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES.appearance).toBe('dawn');
    expect(DEFAULT_PREFERENCES.contrast).toBe('standard');
    expect(DEFAULT_PREFERENCES.transparency).toBe('layered');
    expect(DEFAULT_PREFERENCES.worldArtProfile).toBe('origin-landscape');
    expect(DEFAULT_PREFERENCES.worldArtProfileVersion).toBe(1);
    expect(DEFAULT_PREFERENCES.cameraBob).toBe(false);
    expect(DEFAULT_PREFERENCES.companionBody).toBe('circle');
    expect(DEFAULT_PREFERENCES.companionColor).toBe('rose');
  });

  it('round trips one versioned object', () => {
    const storage = new MemoryStorage();
    const changed = normalisePreferences({
      ...DEFAULT_PREFERENCES,
      appearance: 'dawn',
      contrast: 'high',
      transparency: 'reduced',
      worldArtProfile: 'origin-landscape',
      fieldOfView: 82,
      vignette: 'strong',
      companionBody: 'cloud',
      companionFace: 'happy',
    });
    writePreferences(storage, changed);
    expect(storage.values.has(PREFERENCES_KEY)).toBe(true);
    expect(readPreferences(storage)).toEqual(changed);
  });

  it('normalises style-specific parameters and persists their resolved values', () => {
    const storage = new MemoryStorage();
    const changed = normalisePreferences({
      ...DEFAULT_PREFERENCES,
      worldStyleParameters: {
        vitality: 0.35,
        glass: 99,
        'relationship-energy': 0.2,
        'garden-density': 0.45,
        'horizon-softness': 0.65,
        'surface-finish': 'clear-lens',
        'world-tempo': 1.2,
        'not-a-renderer-capability': 1,
      },
    });

    // The manifest is the authority on which controls exist, so this asserts the shape against it
    // rather than against a copy that goes stale the next time a capability is registered.
    expect(Object.keys(changed.worldStyleParameters).sort())
      .toEqual(worldStyleControls('origin-landscape').map((control) => control.key).sort());
    expect(changed.worldStyleParameters).toMatchObject({
      vitality: 0.35,
      // Out of range, so the manifest's bound wins over the stored value.
      glass: 1,
      'relationship-energy': 0.2,
      'garden-density': 0.45,
      'horizon-softness': 0.65,
      'surface-finish': 'clear-lens',
      'world-tempo': 1.2,
    });
    // A control the stored preferences never mentioned resolves to its declared default.
    expect(changed.worldStyleParameters['source-hue'])
      .toBe(worldStyleControls('origin-landscape')
        .find((control) => control.key === 'source-hue')?.defaultValue);
    expect(changed.worldStyleParameters['not-a-renderer-capability']).toBeUndefined();
    writePreferences(storage, changed);
    expect(readPreferences(storage).worldStyleParameters).toEqual(changed.worldStyleParameters);
  });

  it('falls back field by field when stored data is malformed', () => {
    const value = normalisePreferences({
      appearance: 'ultraviolet',
      fieldOfView: 140,
      mouseSensitivity: 1.5,
      cameraBob: true,
    });
    expect(value.appearance).toBe(DEFAULT_PREFERENCES.appearance);
    expect(value.contrast).toBe(DEFAULT_PREFERENCES.contrast);
    expect(value.transparency).toBe(DEFAULT_PREFERENCES.transparency);
    expect(value.worldArtProfile).toBe(DEFAULT_PREFERENCES.worldArtProfile);
    expect(value.fieldOfView).toBe(DEFAULT_PREFERENCES.fieldOfView);
    expect(value.mouseSensitivity).toBe(1.5);
    expect(value.cameraBob).toBe(true);
  });

  it('migrates the rejected robot choices as one set instead of mixing visual systems', () => {
    const migrated = normalisePreferences({
      ...DEFAULT_PREFERENCES,
      companionBody: 'lantern',
      companionColor: 'mint',
      companionFace: 'calm',
      companionAccessory: 'antenna',
    });
    expect(migrated.companionBody).toBe('circle');
    expect(migrated.companionColor).toBe('rose');
    expect(migrated.companionFace).toBe('neutral');
    expect(migrated).not.toHaveProperty('companionAccessory');
  });

  it('keeps daylight independent of the device color scheme', () => {
    expect(resolvedAppearance('dawn', true)).toBe('dawn');
    expect(resolvedAppearance('dawn', false)).toBe('dawn');
  });

  it('migrates abandoned experimental world treatments back to the authored default', () => {
    expect(normalisePreferences({ worldArtProfile: 'celestial-emulsion' }).worldArtProfile)
      .toBe('origin-landscape');
    expect(normalisePreferences({ worldArtProfile: 'survey-relief' }).worldArtProfile)
      .toBe('origin-landscape');
  });

  it('does not reinterpret an unknown version as the current world recipe', () => {
    const value = normalisePreferences({
      ...DEFAULT_PREFERENCES,
      worldArtProfile: 'origin-landscape',
      worldArtProfileVersion: 99,
      worldStyleParameters: { vitality: 0 },
    });
    expect(value.worldArtProfileVersion).toBe(1);
    expect(value.worldStyleParameters).toEqual(DEFAULT_PREFERENCES.worldStyleParameters);
  });
});

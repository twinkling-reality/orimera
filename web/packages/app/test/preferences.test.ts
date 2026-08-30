import { describe, expect, it } from 'vitest';
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
    expect(DEFAULT_PREFERENCES.cameraBob).toBe(false);
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
        'not-a-renderer-capability': 1,
      },
    });

    expect(changed.worldStyleParameters).toEqual({
      vitality: 0.35,
      glass: 1,
      'relationship-energy': 0.2,
      'garden-density': 0.45,
      'horizon-softness': 0.65,
    });
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
});

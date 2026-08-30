// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { DAWN_THEME } from '@orimera/presentation';
import { DEFAULT_PREFERENCES, normalisePreferences } from '../src/preferences.js';
import { applyDocumentAppearance, applyDocumentTheme, themeForPreferences } from '../src/theme.js';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-contrast');
  document.documentElement.removeAttribute('data-transparency');
  document.documentElement.removeAttribute('style');
});

describe('Atlas presentation theme', () => {
  it('selects one shared token exposure before the document paints', () => {
    applyDocumentTheme(DAWN_THEME);
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe('dawn');
    expect(root.style.colorScheme).toBe('light');
  });

  it('migrates legacy System preferences to the one authored daylight exposure', () => {
    const system = normalisePreferences({ ...DEFAULT_PREFERENCES, appearance: 'system' });
    expect(themeForPreferences(system, false)).toBe(DAWN_THEME);
    expect(themeForPreferences(system, true)).toBe(DAWN_THEME);
    expect(themeForPreferences(DEFAULT_PREFERENCES, false)).toBe(DAWN_THEME);
    expect(themeForPreferences(DEFAULT_PREFERENCES, true)).toBe(DAWN_THEME);
  });

  it('applies exposure, contrast and transparency as one document decision', () => {
    const preferences = normalisePreferences({
      ...DEFAULT_PREFERENCES,
      appearance: 'dawn',
      contrast: 'high',
      transparency: 'reduced',
    });
    expect(applyDocumentAppearance(preferences, true)).toBe(DAWN_THEME);
    expect(document.documentElement.dataset['theme']).toBe('dawn');
    expect(document.documentElement.dataset['contrast']).toBe('high');
    expect(document.documentElement.dataset['transparency']).toBe('reduced');
  });
});

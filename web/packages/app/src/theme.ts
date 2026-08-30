import {
  PRESENTATION_THEMES,
  type PresentationTheme,
} from '@orimera/presentation';
import { resolvedAppearance, type AtlasPreferences } from './preferences.js';

export function themeForPreferences(
  preferences: AtlasPreferences,
  systemDark: boolean,
): PresentationTheme {
  return PRESENTATION_THEMES[resolvedAppearance(preferences.appearance, systemDark)];
}

/** The small DOM adapter; the theme definition itself remains engine and browser neutral. */
export function applyDocumentTheme(
  theme: PresentationTheme,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset['theme'] = theme.name;
  root.style.colorScheme = theme.colorScheme;
}

/** Apply every document-level appearance decision together so surfaces cannot drift. */
export function applyDocumentAppearance(
  preferences: AtlasPreferences,
  systemDark: boolean,
  root: HTMLElement = document.documentElement,
): PresentationTheme {
  const theme = themeForPreferences(preferences, systemDark);
  applyDocumentTheme(theme, root);
  root.dataset['contrast'] = preferences.contrast;
  root.dataset['transparency'] = preferences.transparency;
  return theme;
}

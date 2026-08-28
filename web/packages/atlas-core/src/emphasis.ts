/**
 * Emphasis levels and the single float every renderable reads.
 *
 * interaction-model.md 7.2: "Emphasis levels are primary, secondary, normal, muted, hidden, and
 * every renderable reads one float uniform derived from them, controlling opacity, saturation,
 * bloom, fog boost, and whether the object is interactable and labelable."
 *
 * The float is the contract with both candidate renderers in ADR-0003, which is why the mapping
 * lives here and not in either binding.
 */

export type EmphasisLevel = 'primary' | 'secondary' | 'normal' | 'muted' | 'hidden';

export const EMPHASIS_SCALAR: Readonly<Record<EmphasisLevel, number>> = Object.freeze({
  primary: 1,
  secondary: 0.7,
  normal: 0.45,
  muted: 0.12,
  hidden: 0,
});

/**
 * Interactability and labelability, derived from the level rather than stored.
 *
 * `muted` stays interactable and labelable on purpose. Anti-disorientation rule 1 says mute, do
 * not hide, precisely so the world's shape survives a query; a muted anchor the user can walk up
 * to and still identify is the point. `hidden` is neither, and `hidden` is reserved for content
 * the user deleted.
 */
export function isInteractable(level: EmphasisLevel): boolean {
  return level !== 'hidden';
}

export function isLabelable(level: EmphasisLevel): boolean {
  return level !== 'hidden';
}

/**
 * Emphasis contribution to derived importance (interaction-model.md 3.3).
 *
 * "importance is derived rather than authored: unresolved status, current view emphasis, and
 * normalized occurrence count. A recomposition therefore automatically makes the relevant things
 * easier to aim at, which is a real ergonomic payoff for free."
 */
export function emphasisImportance(level: EmphasisLevel): number {
  return EMPHASIS_SCALAR[level];
}

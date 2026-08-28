import type { ViewManifest } from './types.js';

/**
 * Client manifest state (interaction-model.md 7.2, final paragraph).
 *
 * "Client state holds a manifest STACK (push on refine, pop on Backspace), an active manifest, a
 * pinned manifest that survives navigation and shows as a HUD chip, and an ephemeral PREVIEW
 * slot."
 *
 * All four are here, all transitions are pure, and every operation returns a new state object.
 * That is what makes recomposition reversible: popping a stack rather than rebuilding a scene.
 */
export interface ManifestState {
  /** Push on refine. The last element is the active manifest unless a preview is set. */
  readonly stack: readonly ViewManifest[];
  /** Survives navigation, shows as a HUD chip, and is not popped by Backspace. */
  readonly pinned: ViewManifest | null;
  /**
   * Ephemeral. Set by hovering or keyboard-focusing a dialogue option whose proposed update
   * would change the world; cleared on blur. This is the mechanism behind the tier 2 blast
   * radius preview (5.3) and it is the same code path as a query.
   */
  readonly preview: ViewManifest | null;
}

export const EMPTY_MANIFEST_STATE: ManifestState = Object.freeze({
  stack: Object.freeze([]),
  pinned: null,
  preview: null,
});

/**
 * The manifest that should be applied this frame.
 *
 * Precedence: preview beats the stack beats the pinned manifest. The preview wins because the
 * whole point of the blast radius preview is that the user sees the consequence of the thing
 * under their cursor, not the query they ran a minute ago.
 */
export function resolveActive(state: ManifestState): ViewManifest | null {
  if (state.preview !== null) return state.preview;
  const top = state.stack[state.stack.length - 1];
  if (top !== undefined) return top;
  return state.pinned;
}

export function pushManifest(state: ManifestState, manifest: ViewManifest): ManifestState {
  return Object.freeze({ ...state, stack: Object.freeze([...state.stack, manifest]) });
}

/** Backspace. Popping an empty stack is a no-op, not an error: the user pressed a key. */
export function popManifest(state: ManifestState): ManifestState {
  if (state.stack.length === 0) return state;
  return Object.freeze({ ...state, stack: Object.freeze(state.stack.slice(0, -1)) });
}

export function clearStack(state: ManifestState): ManifestState {
  return Object.freeze({ ...state, stack: Object.freeze([]) });
}

export function pinManifest(state: ManifestState, manifest: ViewManifest | null): ManifestState {
  return Object.freeze({ ...state, pinned: manifest });
}

export function setPreview(state: ManifestState, manifest: ViewManifest): ManifestState {
  return Object.freeze({ ...state, preview: manifest });
}

/** Blur, or Cancel on a tier 2 confirmation. Restores instantly because nothing was mutated. */
export function clearPreview(state: ManifestState): ManifestState {
  if (state.preview === null) return state;
  return Object.freeze({ ...state, preview: null });
}

/**
 * Manifests in the stack that were computed against an older graph state.
 *
 * 7.5: a stale manifest is recomputed, and if recomputation materially changes the result the
 * caption says so rather than the world silently rearranging. This function finds them; deciding
 * what to say about them is the caller's job.
 */
export function staleManifests(
  state: ManifestState,
  sceneStateVersion: number,
): readonly ViewManifest[] {
  const all = [...state.stack];
  if (state.pinned !== null) all.push(state.pinned);
  if (state.preview !== null) all.push(state.preview);
  return all.filter((m) => m.stateVersion !== sceneStateVersion);
}

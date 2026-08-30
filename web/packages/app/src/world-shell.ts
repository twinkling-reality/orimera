/**
 * The Atlas shell state, separate from DOM and renderer concerns.
 *
 * Pointer lock still owns the input mode. This state only answers which product surface is
 * occupying the live world and which camera presentation is active. Keeping those answers in one
 * reducer prevents Index, Options, Map and an orphaned detail pane from independently claiming the
 * same pixels.
 */

export type PrimarySurface = 'world' | 'index' | 'options' | 'controls';
export type CameraPresentation = 'ground' | 'map';

export interface WorldShellState {
  readonly primary: PrimarySurface;
  readonly camera: CameraPresentation;
  /** A detail belongs to the Index. It is illegal on every other primary surface. */
  readonly detailId: string | null;
  /** System surfaces return to the exact place from which they were opened. */
  readonly returnTo: {
    readonly primary: 'world' | 'index';
    readonly camera: CameraPresentation;
    readonly detailId: string | null;
  } | null;
}

export type WorldShellEvent =
  | { readonly type: 'toggle-index' }
  | { readonly type: 'toggle-map' }
  | { readonly type: 'toggle-options' }
  | { readonly type: 'toggle-controls' }
  | { readonly type: 'show-world' }
  | { readonly type: 'show-detail'; readonly id: string }
  | { readonly type: 'close-detail' };

export type WorldCommand =
  | 'toggle-index'
  | 'toggle-map'
  | 'toggle-options'
  | 'toggle-controls'
  | 'selection-back';

export interface CommandKeystroke {
  readonly code: string;
  readonly key: string;
  readonly modified: boolean;
  readonly typing: boolean;
}

export function initialWorldShell(): WorldShellState {
  return Object.freeze({
    primary: 'world',
    camera: 'ground',
    detailId: null,
    returnTo: null,
  });
}

/** One transition function is the collision policy. */
export function updateWorldShell(
  state: WorldShellState,
  event: WorldShellEvent,
): WorldShellState {
  switch (event.type) {
    case 'toggle-index':
      return state.primary === 'index'
        ? initialWorldShell()
        : Object.freeze({ primary: 'index', camera: 'ground', detailId: null, returnTo: null });
    case 'toggle-map':
      return state.camera === 'map'
        ? initialWorldShell()
        : Object.freeze({ primary: 'world', camera: 'map', detailId: null, returnTo: null });
    case 'toggle-options':
      if (state.primary === 'options') return restoreSurface(state);
      if (state.primary === 'controls') return Object.freeze({ ...state, primary: 'options' });
      return openSystemSurface(state, 'options');
    case 'toggle-controls':
      if (state.primary === 'controls') return restoreSurface(state);
      if (state.primary === 'options') return Object.freeze({ ...state, primary: 'controls' });
      return openSystemSurface(state, 'controls');
    case 'show-world':
      return initialWorldShell();
    case 'show-detail':
      return state.primary === 'index'
        ? Object.freeze({ ...state, detailId: event.id })
        : state;
    case 'close-detail':
      return state.detailId === null ? state : Object.freeze({ ...state, detailId: null });
  }
}

function openSystemSurface(
  state: WorldShellState,
  primary: 'options' | 'controls',
): WorldShellState {
  return Object.freeze({
    primary,
    camera: 'ground',
    detailId: null,
    returnTo: Object.freeze({
      primary: state.primary === 'index' ? 'index' : 'world',
      camera: state.camera,
      detailId: state.primary === 'index' ? state.detailId : null,
    }),
  });
}

function restoreSurface(state: WorldShellState): WorldShellState {
  const prior = state.returnTo;
  return prior === null
    ? initialWorldShell()
    : Object.freeze({ ...prior, returnTo: null });
}

/**
 * Resolve only shell-owned keys. World verbs stay in the renderer controls and dialogue number
 * keys stay in the Companion surface. Modified shortcuts and editable controls always keep their
 * native/browser meaning.
 */
export function commandForKeystroke(stroke: CommandKeystroke): WorldCommand | null {
  if (stroke.modified || stroke.typing) return null;
  switch (stroke.code) {
    case 'KeyI':
      return 'toggle-index';
    case 'KeyM':
      return 'toggle-map';
    case 'KeyO':
      return 'toggle-options';
    case 'Backspace':
      return 'selection-back';
    default:
      return stroke.key === '?' ? 'toggle-controls' : null;
  }
}

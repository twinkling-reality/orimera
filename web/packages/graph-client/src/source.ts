/**
 * The read boundary used by every surface that needs the entity graph.
 *
 * A source answers with the existing `GraphSnapshot` read model. The HTTP client and the
 * development fixture source both implement this contract, so changing modes changes where the
 * snapshot comes from rather than what the Atlas, Companion, or World Index receives.
 *
 * The boundary deliberately has no fallback operation. A caller chooses one source explicitly.
 * If a live source fails, its rejected promise remains a live failure and cannot turn into fixture
 * data inside this package.
 */

import type { GraphSnapshot } from './read-model.js';

export interface GraphSource {
  /** The whole graph at one state version. */
  snapshot(): Promise<GraphSnapshot>;
}

export type GraphLoadState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'empty'; readonly snapshot: GraphSnapshot }
  | { readonly phase: 'ready'; readonly snapshot: GraphSnapshot }
  | { readonly phase: 'error'; readonly error: unknown };

export type TerminalGraphLoadState = Exclude<GraphLoadState, { readonly phase: 'loading' }>;

/**
 * Load one explicitly chosen source and report the states a graph surface can render.
 *
 * `partial` is not a graph transport state today. A successful snapshot can produce a partial
 * Atlas later when the scene adapter reports omitted islands or occurrence classes it cannot draw.
 * Keeping that distinction here prevents a complete HTTP response from being labelled partial
 * merely because the current renderer has a documented limit.
 */
export async function loadGraph(
  source: GraphSource,
  onState: (state: GraphLoadState) => void = () => undefined,
): Promise<TerminalGraphLoadState> {
  onState({ phase: 'loading' });
  try {
    const snapshot = await source.snapshot();
    const phase =
      snapshot.entities.length === 0 &&
      snapshot.occurrences.length === 0 &&
      snapshot.islands.length === 0
        ? 'empty'
        : 'ready';
    const state: TerminalGraphLoadState = { phase, snapshot };
    onState(state);
    return state;
  } catch (error) {
    const state: TerminalGraphLoadState = { phase: 'error', error };
    onState(state);
    return state;
  }
}

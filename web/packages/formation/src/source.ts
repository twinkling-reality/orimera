/**
 * The event source interface.
 *
 * One interface with two implementations, so that swapping the mock for the real provenance
 * ledger is a constructor change and not a redesign. The shape is dictated by
 * interaction-model.md 8.4: server-sent events per capture, resumed from the last event id.
 *
 * The real implementation is `HttpFormationEventSource` in `./http-source.ts`, and it is a
 * `fetch` reader rather than the browser event-source object this comment used to sketch. That sketch
 * was wrong in a way worth recording: the browser's `EventSource` sends no custom headers, so it
 * cannot carry a bearer token, and the only ways to make it authenticate are a credential in the
 * query string or a cookie session this API does not have. The first would put the key to
 * somebody's photograph library in every proxy log on the way.
 *
 * ASSUMPTION A-29, whether the pipeline can emit real per-stage counters, is now settled by
 * `exulanica/ingest/formation.py`: it can, for the stages that run, by counting runs that have
 * finished each stage. What it cannot count is a stage that is one run for the whole batch, and
 * that arrives as a stage reporting no counters, which is the state this client was already
 * built to render as breathing plus elapsed time rather than as a guess.
 */

import type { StageEvent } from './events.js';
import type { StreamState } from './state.js';

export interface FormationEventSource {
  /**
   * @param fromEventId resume token, or null for a fresh subscription
   * @returns an unsubscribe function
   */
  subscribe(
    captureId: string,
    fromEventId: string | null,
    onEvent: (event: StageEvent) => void,
    onStreamState: (stream: StreamState) => void,
  ): () => void;
}

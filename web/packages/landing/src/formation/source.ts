/**
 * The event source interface.
 *
 * One interface with two implementations, so that swapping the mock for the real provenance
 * ledger is a constructor change and not a redesign. The shape is dictated by
 * interaction-model.md 8.4: server-sent events per capture, resumed from the last event id.
 *
 * The real implementation is roughly:
 *
 *     const es = new EventSource(`/api/captures/${captureId}/formation?from=${fromEventId ?? ''}`);
 *     es.onmessage = (m) => onEvent(JSON.parse(m.data) as StageEvent);
 *     es.onerror = () => onStreamState('lost');
 *
 * It does not exist yet because ASSUMPTION A-29 is unsettled: whether the pipeline can emit real
 * per-stage counters is an open backend question (product-specification.md 9, item A-29). The
 * client is built so that the answer changes the data and not the code: a stage that reports no
 * counters renders as breathing plus elapsed time, which is already a supported state.
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

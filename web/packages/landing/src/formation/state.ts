/**
 * The formation reducer: stage events in, one state out.
 *
 * The single rule this file exists to enforce is interaction-model.md 8.1: "Every visual
 * formation state is paired with a factual label naming the real pipeline stage and the real unit
 * of progress. There is no synthetic progress bar and no invented percentage."
 *
 * Concretely, three things are absent on purpose and their absence is the design:
 *
 *   1. There is no timer. Nothing here advances between events. If the pipeline goes quiet the
 *      state stops changing, which is what makes the "frozen on stream loss" rule (8.4) free
 *      rather than a special case.
 *   2. There is no smoothing, easing or interpolation of a counter. `counters` is whatever the
 *      last event carried. If the backend delivers in a burst, the display jumps in a burst.
 *   3. There is no default for an unknown total. `progressFraction` returns `null`, and every
 *      caller has to decide what to do with `null` rather than being handed a plausible number.
 */

import {
  assertUsableEvent,
  isOutcome,
  phaseIndex,
  type DetectionCounts,
  type FormationPhase,
  type OutcomeFacts,
  type StageCounters,
  type StageEvent,
} from './events.js';

/**
 * Connection state of the event stream, which is a different thing from the pipeline's state.
 * `lost` means we do not know what the pipeline is doing, and that is displayed as such.
 */
export type StreamState = 'connecting' | 'live' | 'lost';

export interface FormationState {
  readonly captureId: string;
  readonly phase: FormationPhase;
  readonly stageIndex: number;
  /** The counters from the newest event for the current phase, or null if it carried none. */
  readonly counters: StageCounters | null;
  readonly detections: DetectionCounts | null;
  readonly outcome: OutcomeFacts | null;
  readonly photographs: number | null;
  readonly note: string | null;
  /** Resume token for reconnect. */
  readonly lastEventId: string | null;
  /** Server timestamps. Elapsed time is a difference of these two and never uses the local clock. */
  readonly startedAt: number | null;
  readonly lastEventAt: number | null;
  readonly stream: StreamState;
}

export function initialFormationState(captureId: string): FormationState {
  return {
    captureId,
    phase: 'received',
    stageIndex: 0,
    counters: null,
    detections: null,
    outcome: null,
    photographs: null,
    note: null,
    lastEventId: null,
    startedAt: null,
    lastEventAt: null,
    stream: 'connecting',
  };
}

/**
 * Apply one event.
 *
 * Out-of-order events are dropped rather than applied, because server-sent events can be
 * redelivered on reconnect and replaying an older stage would walk the visual backwards. Within
 * one phase the newer server timestamp wins.
 */
export function reduceFormation(state: FormationState, event: StageEvent): FormationState {
  assertUsableEvent(event);
  if (event.captureId !== state.captureId) return state;

  const incoming = phaseIndex(event.phase);
  const current = phaseIndex(state.phase);
  if (incoming < current) return state;
  if (incoming === current && state.lastEventAt !== null && event.at < state.lastEventAt) {
    return state;
  }

  const phaseChanged = event.phase !== state.phase;

  return {
    ...state,
    phase: event.phase,
    stageIndex: event.stageIndex,
    // A new phase starts with no counters of its own. Carrying the previous stage's counters
    // forward would show "62 of 148" under a stage that has not counted anything yet.
    counters: event.counters ?? (phaseChanged ? null : state.counters),
    // Detections accumulate across the run: once found, they stay found, and the anchor motes
    // stay lit. This is the one value that legitimately survives a phase change.
    detections: event.detections ?? state.detections,
    outcome: event.outcome ?? (isOutcome(event.phase) ? state.outcome : null),
    photographs: event.photographs ?? state.photographs,
    note: event.note ?? (phaseChanged ? null : state.note),
    lastEventId: event.eventId,
    startedAt: state.startedAt ?? event.at,
    lastEventAt: event.at,
    stream: 'live',
  };
}

export function withStreamState(state: FormationState, stream: StreamState): FormationState {
  return state.stream === stream ? state : { ...state, stream };
}

/**
 * The measured fraction, or null.
 *
 * Null is returned whenever the total is unknown, when the total is zero, or when the stage has
 * not reported counters at all. Callers must render null as a breathing, non-advancing visual
 * (8.3), which is the whole reason this cannot fall back to a guess.
 *
 * `done > total` is clamped to 1 for the visual only. The label prints the raw pair, so an
 * over-count stays visible in words instead of being hidden by the clamp.
 */
export function progressFraction(state: FormationState): number | null {
  const c = state.counters;
  if (!c || c.total === null || c.total <= 0) return null;
  return Math.min(1, c.done / c.total);
}

/** Milliseconds between the first and the newest event. Never uses the local clock. */
export function elapsedMs(state: FormationState): number | null {
  if (state.startedAt === null || state.lastEventAt === null) return null;
  return Math.max(0, state.lastEventAt - state.startedAt);
}

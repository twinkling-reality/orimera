/**
 * MOCK EVENT SOURCE. NOT A PIPELINE. NOTHING HERE IS MEASURED.
 * ============================================================
 *
 * This file fabricates stage events so that the formation visuals and their labels can be
 * developed and reviewed before the provenance ledger exposes a stream. It is the only file in
 * this package that invents a number, and that is why it is the only file whose name says so.
 *
 * Two guardrails keep it from turning into a fake progress bar by accident:
 *
 *   1. It emits **events**, not frames. It cannot interpolate, because the reducer downstream has
 *      no timer to interpolate with. What the UI shows between two events is what the last event
 *      said, exactly as it will be against the real stream.
 *   2. Its scripts are **irregular on purpose**: bursts, gaps, stages that report no counters at
 *      all, and a stage whose total is unknown for a while. A script that ticked smoothly from
 *      0 to 100 would let a dishonest renderer look correct.
 *
 * Any surface that mounts this must display the mock banner. `IS_MOCK` is exported so that check
 * can be a value rather than a habit.
 */

import type { FormationPhase, StageEvent } from './events.js';
import type { FormationEventSource } from './source.js';
import type { StreamState } from './state.js';

export const IS_MOCK = true;

export const MOCK_BANNER =
  'Mock event source. These counts are scripted, not measured. The real stream is server-sent events from the provenance ledger.';

export type MockScenario = 'ready' | 'review_required' | 'partial' | 'failed' | 'stream_loss';

/** One scripted beat: a delay since the previous beat, then an event, or a stream state change. */
interface Beat {
  readonly afterMs: number;
  readonly event?: Omit<StageEvent, 'eventId' | 'captureId'>;
  readonly stream?: StreamState;
}

const PHOTOGRAPHS = 148;

function ev(
  phase: FormationPhase,
  stageIndex: number,
  extra: Partial<Omit<StageEvent, 'eventId' | 'captureId' | 'phase' | 'stageIndex' | 'at'>> = {},
): Omit<StageEvent, 'eventId' | 'captureId'> {
  return { phase, stageIndex, at: 0, ...extra };
}

/** The stages every scenario shares, up to the point where they diverge. */
const COMMON: readonly Beat[] = [
  { afterMs: 300, event: ev('received', 0, { photographs: PHOTOGRAPHS }) },

  // Decode arrives in bursts, and the total is genuinely unknown for the first two events.
  { afterMs: 1100, event: ev('media_extraction', 1, { counters: { done: 9, total: null } }) },
  { afterMs: 700, event: ev('media_extraction', 1, { counters: { done: 34, total: null } }) },
  { afterMs: 500, event: ev('media_extraction', 1, { counters: { done: 62, total: PHOTOGRAPHS } }) },
  { afterMs: 900, event: ev('media_extraction', 1, { counters: { done: 148, total: PHOTOGRAPHS } }) },

  { afterMs: 800, event: ev('camera_recovery', 2, { counters: { done: 12, total: PHOTOGRAPHS } }) },
  { afterMs: 1400, event: ev('camera_recovery', 2, { counters: { done: 91, total: PHOTOGRAPHS } }) },
];

/**
 * Dense reconstruction with no counters at all, which is the A-29 failure case rendered as a
 * first-class state: the visual breathes and the label shows elapsed time.
 */
const RECONSTRUCTION_UNMEASURED: readonly Beat[] = [
  { afterMs: 900, event: ev('reconstruction', 3, { note: 'gsplat training started' }) },
  { afterMs: 2600, event: ev('reconstruction', 3) },
];

const RECONSTRUCTION_MEASURED: readonly Beat[] = [
  { afterMs: 900, event: ev('reconstruction', 3, { counters: { done: 3, total: 24 } }) },
  { afterMs: 1500, event: ev('reconstruction', 3, { counters: { done: 24, total: 24 } }) },
];

const INDEXING: readonly Beat[] = [
  { afterMs: 700, event: ev('entity_indexing', 4, { detections: { people: 4, objects: 1, places: 0 } }) },
  { afterMs: 400, event: ev('entity_indexing', 4, { detections: { people: 12, objects: 4, places: 2 } }) },
];

const LINKING: readonly Beat[] = [
  { afterMs: 800, event: ev('continuity_search', 5, { counters: { done: 0, total: 2 } }) },
  { afterMs: 1100, event: ev('continuity_search', 5, { counters: { done: 2, total: 2 } }) },
];

const SCRIPTS: Readonly<Record<MockScenario, readonly Beat[]>> = Object.freeze({
  ready: [
    ...COMMON,
    ...RECONSTRUCTION_MEASURED,
    ...INDEXING,
    ...LINKING,
    {
      afterMs: 900,
      event: ev('ready', 6, {
        outcome: { rung: 1, openQuestions: 7, photographsAvailable: PHOTOGRAPHS },
      }),
    },
  ],

  review_required: [
    ...COMMON,
    ...RECONSTRUCTION_UNMEASURED,
    ...INDEXING,
    ...LINKING,
    {
      afterMs: 900,
      event: ev('review_required', 6, {
        outcome: { rung: 3, openQuestions: 11, photographsAvailable: PHOTOGRAPHS },
      }),
    },
  ],

  partial: [
    ...COMMON,
    ...RECONSTRUCTION_UNMEASURED,
    ...INDEXING,
    {
      afterMs: 1200,
      event: ev('partial', 6, {
        outcome: {
          rung: 3,
          openQuestions: 5,
          photographsAvailable: PHOTOGRAPHS,
          stoppedAt: 'continuity_search',
        },
        note: 'linking worker preempted',
      }),
    },
  ],

  failed: [
    ...COMMON,
    {
      afterMs: 1600,
      event: ev('failed', 6, {
        counters: { done: 91, total: PHOTOGRAPHS },
        outcome: {
          rung: 4,
          openQuestions: 0,
          photographsAvailable: PHOTOGRAPHS,
          stoppedAt: 'camera_recovery',
          reason: 'insufficient_registration',
        },
      }),
    },
  ],

  // The stream drops mid-stage and never returns. Nothing after this beat moves.
  stream_loss: [...COMMON, { afterMs: 1200, stream: 'lost' }],
});

export class MockFormationEventSource implements FormationEventSource {
  readonly isMock = IS_MOCK;

  constructor(private readonly scenario: MockScenario) {}

  subscribe(
    captureId: string,
    fromEventId: string | null,
    onEvent: (event: StageEvent) => void,
    onStreamState: (stream: StreamState) => void,
  ): () => void {
    const beats = SCRIPTS[this.scenario];
    // Resume semantics, exercised rather than assumed: a reconnect replays from after the token.
    const start = fromEventId === null ? 0 : indexAfter(beats, fromEventId);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    onStreamState('connecting');

    let at = 0;
    let wall = Date.now();
    for (let i = start; i < beats.length; i += 1) {
      const beat = beats[i];
      if (!beat) continue;
      at += beat.afterMs;
      wall += beat.afterMs;
      const stamp = wall;
      const index = i;
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          if (beat.stream) {
            onStreamState(beat.stream);
            return;
          }
          if (!beat.event) return;
          onEvent({ ...beat.event, eventId: eventIdOf(index), captureId, at: stamp });
        }, at),
      );
    }

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }
}

function eventIdOf(index: number): string {
  return `mock-${String(index).padStart(3, '0')}`;
}

function indexAfter(beats: readonly Beat[], eventId: string): number {
  for (let i = 0; i < beats.length; i += 1) {
    if (eventIdOf(i) === eventId) return i + 1;
  }
  return 0;
}

/**
 * The terminal state of a scenario, with no waiting.
 *
 * Used by the "Explore a sample world" path, which lands on an already-formed region. It replays
 * the same scripted events through the same reducer rather than hand-writing a finished state, so
 * the sample world cannot drift from what the live path would produce.
 */
export function replayToEnd(
  scenario: MockScenario,
  captureId: string,
  apply: (event: StageEvent) => void,
): void {
  const beats = SCRIPTS[scenario];
  let wall = Date.now();
  beats.forEach((beat, i) => {
    wall += beat.afterMs;
    if (beat.event) apply({ ...beat.event, eventId: eventIdOf(i), captureId, at: wall });
  });
}

export const MOCK_SCENARIOS: readonly MockScenario[] = Object.keys(SCRIPTS) as MockScenario[];

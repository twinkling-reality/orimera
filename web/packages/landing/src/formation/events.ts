/**
 * The stage event, as it arrives from the pipeline.
 *
 * interaction-model.md 8.4: "Progress arrives as server-sent events per capture, each carrying
 * stage, stage index, counters, a message, a timestamp and an event id. The client maps events to
 * visual state and resumes from the last event id on reconnect."
 *
 * This file is the contract. It is deliberately the whole contract, because section 8 rests on
 * ASSUMPTION A-29 ("the pipeline emits real per-stage counters") and that assumption is not yet
 * settled. The shape below is built so that the unsettled half is representable as absent rather
 * than as a lie: `counters` is optional and `total` is nullable, and everything downstream treats
 * an absent counter as "not known" and never as zero, never as done, and never as a fraction.
 */

/**
 * The stages a capture passes through, in order. The names are the real pipeline stages from
 * interaction-model.md 8.2 with the video-era audio stage removed, not invented UI phases.
 *
 * Three of them already exist by these names in the backend stage registry
 * (`orimera/ingest/stages.py`): `intake` and `rendition` are the two halves of `media_extraction`,
 * `vision` is `entity_indexing`, and `scene_group` is the first half of `continuity_search`.
 * `camera_recovery` and `reconstruction` are the offline reconstruction job, which
 * product-specification.md section 5 says never runs in the live demo path.
 */
export const FORMATION_STAGES = [
  'received',
  'media_extraction',
  'camera_recovery',
  'reconstruction',
  'entity_indexing',
  'continuity_search',
] as const;

export type FormationStage = (typeof FORMATION_STAGES)[number];

/**
 * Terminal states. `partial` and `failed` are first-class outcomes, not error screens:
 * interaction-model.md 8.3, "failure leaves the partial region in place", and
 * "partial usability is the point".
 */
export const FORMATION_OUTCOMES = ['review_required', 'ready', 'partial', 'failed'] as const;

export type FormationOutcome = (typeof FORMATION_OUTCOMES)[number];

export type FormationPhase = FormationStage | FormationOutcome;

export function isOutcome(phase: FormationPhase): phase is FormationOutcome {
  return (FORMATION_OUTCOMES as readonly string[]).includes(phase);
}

/** Position of a phase in the sequence. Outcomes sort after every stage. */
export function phaseIndex(phase: FormationPhase): number {
  const i = (FORMATION_STAGES as readonly string[]).indexOf(phase);
  return i >= 0 ? i : FORMATION_STAGES.length;
}

/**
 * A counter the pipeline actually measured.
 *
 * `total: null` is the load-bearing case and it is why this is not a `{ done, total }` pair of
 * numbers. A stage that knows it has processed 62 images but does not yet know how many there
 * are is a real state, and the only honest rendering of it is "62 read so far, total not yet
 * known" with a breathing visual. Defaulting `total` to `done` would render that same state as
 * 100% complete.
 */
export interface StageCounters {
  readonly done: number;
  readonly total: number | null;
}

/**
 * What entity detection has found so far. Separate from `StageCounters` because it is a set of
 * counts rather than a progress pair, and because the anchor motes drawn in the world are
 * `people + objects + places` exactly: one mote per detection that has actually landed
 * (interaction-model.md 8.3, "a stage's visual must never run ahead of the data").
 */
export interface DetectionCounts {
  readonly people: number;
  readonly objects: number;
  readonly places: number;
}

export type FailureReason =
  /** Structure from motion registered too few images to build a single model. */
  | 'insufficient_registration'
  /** A stage raised an error. */
  | 'stage_error'
  /** The user or the operator stopped the job. */
  | 'cancelled';

/**
 * Facts attached to a terminal event. Every field is a number or a key, never a sentence: the
 * copy is written in `labels.ts` from these values, so the pipeline cannot inject product prose
 * and a wording change does not need a backend deploy.
 */
export interface OutcomeFacts {
  /** The reconstruction rung the region actually earned (product-specification.md 5.1). */
  readonly rung: 1 | 2 | 3 | 4;
  /** Open questions. Allowed to be any number forever; there is no completion metric. */
  readonly openQuestions: number;
  /** Photographs the user can open right now, whatever happened to the geometry. */
  readonly photographsAvailable: number;
  /** For `partial` and `failed`: the stage formation stopped at. */
  readonly stoppedAt?: FormationStage;
  /** For `failed`: why. The sentence is written client-side from this key. */
  readonly reason?: FailureReason;
}

export interface StageEvent {
  /** Resume token. The client reconnects with the last one it saw. */
  readonly eventId: string;
  readonly captureId: string;
  readonly phase: FormationPhase;
  /** The pipeline's own index for this phase. Used to reject out-of-order delivery. */
  readonly stageIndex: number;
  /** Server wall clock, milliseconds. Elapsed time is measured between server timestamps. */
  readonly at: number;
  readonly counters?: StageCounters;
  readonly detections?: DetectionCounts;
  readonly outcome?: OutcomeFacts;
  /** How many photographs the upload contained. Known at `received` and never after. */
  readonly photographs?: number;
  /**
   * The pipeline's own message. Rendered in a slot marked as coming from the pipeline, never
   * merged into the honest label, because the label must be derivable from numbers alone.
   */
  readonly note?: string;
}

export class StageEventError extends Error {}

/**
 * Reject an event that could only produce a dishonest display. This throws rather than clamping:
 * a negative count or a non-finite timestamp is a pipeline bug, and silently rendering a repaired
 * version of it would hide exactly the fault the ledger exists to expose.
 */
export function assertUsableEvent(event: StageEvent): void {
  if (!Number.isFinite(event.at)) throw new StageEventError('event.at must be a finite timestamp');
  const c = event.counters;
  if (c) {
    if (!Number.isInteger(c.done) || c.done < 0) {
      throw new StageEventError(`counters.done must be a non-negative integer, got ${String(c.done)}`);
    }
    if (c.total !== null && (!Number.isInteger(c.total) || c.total < 0)) {
      throw new StageEventError(`counters.total must be null or a non-negative integer`);
    }
  }
  const d = event.detections;
  if (d) {
    for (const [k, v] of Object.entries(d)) {
      if (!Number.isInteger(v) || v < 0) {
        throw new StageEventError(`detections.${k} must be a non-negative integer`);
      }
    }
  }
}

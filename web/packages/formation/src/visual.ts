/**
 * State to visual, and the place where "never fabricate progress" becomes a type.
 *
 * Every field below is either a real count that arrived in an event or `null`. There is no
 * field that a renderer could read as "how far along we probably are", because there is no such
 * number in the system. `resolved: null` is the instruction to breathe rather than advance
 * (interaction-model.md 8.3), and `motion: 'frozen'` is the instruction to stop entirely (8.4).
 */

import { isOutcome } from './events.js';
import { progressFraction, type FormationState } from './state.js';

/**
 * What the field is doing. Not what it looks like: the figure is chosen separately, so a
 * reduced-motion renderer can honour the figure and ignore the motion without losing anything,
 * because the label already carries the information (9, "the label set is identical in both modes").
 */
export type FormationMotion =
  /** A real fraction exists and the figure may advance to it. */
  | 'advance'
  /** No measurable progress. The figure holds and breathes. */
  | 'breathe'
  /** The stream dropped. Nothing moves at all, deliberately. */
  | 'frozen'
  /** Terminal and successful. The figure holds its final shape. */
  | 'settled'
  /** Terminal and failed. Motes settle and dim, and the partial region stays. */
  | 'stopped';

/**
 * The figure the particle field forms. One per stage, from the visual column of the stage map in
 * interaction-model.md 8.2.
 */
export type FormationFigure =
  /** A dim unlit void volume, sparse motes drifting inward. */
  | 'void'
  /** Motes aligning onto a faint horizontal disc, the future ground plane. */
  | 'disc'
  /** Thin wireframe camera frusta along the estimated trajectory. */
  | 'frusta'
  /** Motes migrating onto surfaces, in the order the reconstruction converges. */
  | 'surfaces'
  /** One small mote per detection, at the detection position. */
  | 'anchors'
  /** Threads reaching toward existing regions, dim while uncertain. */
  | 'threads'
  /** The region holds its shape. Unresolved anchors keep the dashed ring. */
  | 'formed';

export interface FormationVisual {
  readonly figure: FormationFigure;
  readonly motion: FormationMotion;
  /**
   * The fraction of the figure that has been earned, or null when no fraction exists. A renderer
   * that receives null must not advance. This is `progressFraction` renamed at the boundary so
   * that a renderer never sees the word "progress" attached to a value that may be a guess.
   */
  readonly resolved: number | null;
  /** Exactly the number of detections that have landed. Never a target, never an estimate. */
  readonly anchorMotes: number;
  /** Exactly the number of candidate links compared so far. */
  readonly threads: number;
  /**
   * How unconfirmed the result looks, 0 to 1, driven by the ratio of open questions to indexed
   * detections. Per-point dissolve driven by real semantic state, not a shader told to look
   * mysterious.
   */
  readonly dissolve: number;
}

const FIGURE_BY_PHASE: Readonly<Record<string, FormationFigure>> = Object.freeze({
  received: 'void',
  media_extraction: 'disc',
  camera_recovery: 'frusta',
  reconstruction: 'surfaces',
  entity_indexing: 'anchors',
  continuity_search: 'threads',
  review_required: 'formed',
  ready: 'formed',
  partial: 'formed',
  failed: 'formed',
});

function motionOf(state: FormationState, resolved: number | null): FormationMotion {
  if (state.stream === 'lost') return 'frozen';
  if (state.phase === 'failed') return 'stopped';
  if (isOutcome(state.phase)) return 'settled';
  return resolved === null ? 'breathe' : 'advance';
}

function dissolveOf(state: FormationState): number {
  const o = state.outcome;
  const d = state.detections;
  if (!o || !d) return 1;
  const indexed = d.people + d.objects + d.places;
  if (indexed <= 0) return o.openQuestions > 0 ? 1 : 0;
  return Math.min(1, o.openQuestions / indexed);
}

export function formationVisual(state: FormationState): FormationVisual {
  const resolved = progressFraction(state);
  const d = state.detections;
  return {
    figure: FIGURE_BY_PHASE[state.phase] ?? 'void',
    motion: motionOf(state, resolved),
    resolved,
    anchorMotes: d ? d.people + d.objects + d.places : 0,
    threads: state.phase === 'continuity_search' ? (state.counters?.done ?? 0) : 0,
    dissolve: dissolveOf(state),
  };
}

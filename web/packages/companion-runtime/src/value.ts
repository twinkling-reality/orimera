import type { EntityRecord } from '@orimera/graph-client';
import type { CompanionMemory } from './memory.js';
import { priorityPenalty } from './memory.js';

/**
 * THE ONE VALUE FUNCTION (interaction-model.md 6.3).
 *
 * "The review queue is the World Index filtered to 'needs review', sorted by THE SAME VALUE
 * FUNCTION THAT DRIVES COMPANION INITIATIVE ... Sharing the value function means the ambient
 * counter, the Companion's choice of what to raise, and the queue order all agree on what
 * matters. IF THEY DISAGREED, THE PRODUCT WOULD FEEL LIKE TWO SYSTEMS ARGUING."
 *
 * It lives in companion-runtime and world-index imports it. That direction is the only one the
 * module contract allows (world-index may import companion-runtime; not the reverse), and it is
 * also the right one: the value function is a policy about what to ASK, and the queue is a view
 * of that policy rather than a policy of its own.
 *
 * The document names no weights. These are a DECISION, gathered here so tuning is one edit, and
 * ordered by what the product claims to be for: a contradiction beats an unknown, cross-region
 * reach beats within-region reach, and a low-confidence guess is worth more to ask about than a
 * high-confidence one because the answer moves it further.
 */
export const VALUE_WEIGHTS = Object.freeze({
  openQuestions: 0.3,
  /** "this person is in both places" is the central product claim, so reach is weighted heavily. */
  crossIslandReach: 0.25,
  contradiction: 0.2,
  occurrenceReach: 0.15,
  lowConfidence: 0.1,
});

/** Saturating normalizer. Four open questions and forty are both simply "a lot". */
function saturate(n: number, half: number): number {
  return n <= 0 ? 0 : n / (n + half);
}

const CONFIDENCE_URGENCY = Object.freeze({ low: 1, medium: 0.5, high: 0.15 });

/**
 * How much the system would gain by getting an answer about this entity.
 *
 * Returns 0..1. Deliberately does NOT read anything about how long the user has been in the
 * session or whether the Companion is allowed to speak: that is the initiative gate's job
 * (initiative.ts), and mixing "is this worth asking" with "may I ask now" is what produces a
 * system that nags about unimportant things during a quiet moment and stays silent about
 * important ones.
 */
export function entityValue(
  entity: EntityRecord,
  memory: CompanionMemory,
  nowMs: number,
): number {
  if (entity.status === 'merged_away' || entity.status === 'rejected') return 0;

  const questions = saturate(entity.openQuestionCount, 2);
  const reach = saturate(Math.max(0, entity.islandIds.length - 1), 1);
  const contradictions = entity.contradictions.length > 0 ? 1 : 0;
  const occurrences = saturate(entity.occurrenceCount, 4);
  const urgency = entity.confidence === null ? 0 : CONFIDENCE_URGENCY[entity.confidence];

  const raw =
    VALUE_WEIGHTS.openQuestions * questions +
    VALUE_WEIGHTS.crossIslandReach * reach +
    VALUE_WEIGHTS.contradiction * contradictions +
    VALUE_WEIGHTS.occurrenceReach * occurrences +
    VALUE_WEIGHTS.lowConfidence * urgency;

  return raw * priorityPenalty(memory, entity.entityId, nowMs);
}

export interface RankedEntity {
  readonly entity: EntityRecord;
  readonly value: number;
}

/**
 * Rank by value, descending, with a total order.
 *
 * The tie-break on `entityId` is not cosmetic: without it two entities with identical value swap
 * places between renders depending on input order, and a review queue that reshuffles under the
 * user's cursor is worse than one in an arbitrary but stable order.
 */
export function rankByValue(
  entities: readonly EntityRecord[],
  memory: CompanionMemory,
  nowMs: number,
): readonly RankedEntity[] {
  return entities
    .map((entity) => ({ entity, value: entityValue(entity, memory, nowMs) }))
    .sort((a, b) => {
      if (a.value !== b.value) return b.value - a.value;
      return a.entity.entityId < b.entity.entityId ? -1 : a.entity.entityId > b.entity.entityId ? 1 : 0;
    });
}

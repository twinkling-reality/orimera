import type { EntityIdRef, EntityRecord, EvidenceHandle, GraphSnapshot } from '@orimera/graph-client';
import { escapeOptions } from './escapes.js';
import type { IdFactory } from './ids.js';
import type { Intent } from './intent.js';
import { intentRank } from './intent.js';
import type { CompanionMemory } from './memory.js';
import { hardSuppression } from './memory.js';
import type { PoolContext } from './pool.js';
import { applicableIntents, buildPool, prune, subjectFootprint } from './pool.js';
import type { ChoiceSet, Turn } from './turn.js';
import { validateTurn } from './turn.js';
import { entityValue } from './value.js';

/**
 * TURN GENERATION (interaction-model.md 4.4), stages 1 to 3.
 *
 * "Each turn is produced by a policy over the entity graph snapshot PLUS THE CONVERSATION
 * TRANSCRIPT." Both inputs matter and they matter differently:
 *
 *   The SNAPSHOT decides which questions are answerable at all. A question about name scope is
 *   unreachable until the entity actually spans two islands.
 *   The MEMORY decides which of the answerable questions may be asked now. It is what stops the
 *   generator returning the same turn forever, and what makes an escape mean something.
 *
 * Change either and the options change. That is the whole mechanism behind "options evolve
 * rather than being a form", and it is why nothing in this file holds a list of buttons.
 */

/**
 * Bounded evidence, mirroring the server-side packet bound in domain-and-evidence-model.md 2.5
 * ("maximum 24 items"). A turn that cited eighty photographs would not be a citation.
 */
export const MAX_TURN_EVIDENCE = 24;

export interface QuestionCandidate {
  readonly entity: EntityRecord;
  readonly intent: Intent;
  readonly value: number;
}

export interface GenerateInput {
  readonly snapshot: GraphSnapshot;
  readonly memory: CompanionMemory;
  readonly nowMs: number;
  readonly ids: IdFactory;
  /**
   * The entity behind the anchor the user just engaged (attention ladder stage 3, 3.2). When the
   * user has pressed Interact on something, that thing is the subject: the Companion answering a
   * question about a different entity than the one under the reticle is the fastest way to make
   * it feel like it is not paying attention.
   */
  readonly focusEntityId?: EntityIdRef | null;
}

/**
 * Every question that could be asked right now, ranked.
 *
 * Ordering is INTENT PRIORITY FIRST, then value. 4.4 stage 1 says the intent is selected "by
 * priority", so a resolve-identity question about a minor entity outranks an enrich-relation
 * question about a major one. Value breaks ties inside a priority band, which is where the
 * shared value function (6.3) does its work.
 */
export function rankQuestions(input: GenerateInput): readonly QuestionCandidate[] {
  const candidates: QuestionCandidate[] = [];
  for (const entity of input.snapshot.entities) {
    for (const intent of applicableIntents(input.snapshot, entity)) {
      if (hardSuppression(input.memory, intent, entity.entityId, input.nowMs) !== null) continue;
      candidates.push({
        entity,
        intent,
        value: entityValue(entity, input.memory, input.nowMs),
      });
    }
  }

  const focus = input.focusEntityId ?? null;
  return candidates.sort((a, b) => {
    if (focus !== null) {
      const af = a.entity.entityId === focus ? 0 : 1;
      const bf = b.entity.entityId === focus ? 0 : 1;
      if (af !== bf) return af - bf;
    }
    const byIntent = intentRank(a.intent) - intentRank(b.intent);
    if (byIntent !== 0) return byIntent;
    if (a.value !== b.value) return b.value - a.value;
    return a.entity.entityId < b.entity.entityId ? -1 : a.entity.entityId > b.entity.entityId ? 1 : 0;
  });
}

export function selectQuestion(input: GenerateInput): QuestionCandidate | null {
  return rankQuestions(input)[0] ?? null;
}

/**
 * Generate the next turn.
 *
 * Always returns a turn. When nothing is open the intent is `acknowledge`: a turn with no choice
 * set, the escapes still present, and free text still available. The Companion having nothing to
 * ask is a normal state and must not render as an error or as an empty panel.
 */
export function generateTurn(input: GenerateInput): Turn {
  const candidate = selectQuestion(input);
  const turnId = input.ids('turn');
  const escapes = escapeOptions();

  if (candidate === null) {
    const turn: Turn = Object.freeze({
      turnId,
      intent: 'acknowledge' as const,
      subjectEntityId: null,
      subjectAnchorId: null,
      utteranceKey: 'utterance.acknowledge',
      utterance: null,
      evidence: Object.freeze([]),
      choiceSet: null,
      freeTextAllowed: true,
      escapes,
      stateVersion: input.snapshot.stateVersion,
    });
    validateTurn(turn);
    return turn;
  }

  const ctx: PoolContext = {
    snapshot: input.snapshot,
    nowMs: input.nowMs,
    ids: input.ids,
    subject: candidate.entity,
  };

  const pool = buildPool(candidate.intent, ctx);
  const options = prune(candidate.intent, ctx, pool);
  const footprint = subjectFootprint(input.snapshot, candidate.entity.entityId);

  const choiceSet: ChoiceSet | null =
    options.length === 0
      ? null
      : Object.freeze({
          mode: pool.mode,
          options,
          // Multi mode always has an explicit submit; single mode commits on click (4.3).
          submitRequired: pool.mode === 'multi',
        });

  const evidence: readonly EvidenceHandle[] = Object.freeze(
    footprint.evidence.slice(0, MAX_TURN_EVIDENCE),
  );

  const turn: Turn = Object.freeze({
    turnId,
    intent: candidate.intent,
    subjectEntityId: candidate.entity.entityId,
    // Connects the question to a focusable world anchor without turning the id into geometry.
    subjectAnchorId: footprint.anchorIds[0] ?? null,
    utteranceKey: pool.utteranceKey,
    utterance: null,
    evidence,
    choiceSet,
    freeTextAllowed: true,
    escapes,
    stateVersion: input.snapshot.stateVersion,
  });

  validateTurn(turn);
  return turn;
}

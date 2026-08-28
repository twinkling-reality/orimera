import type { AnchorIdRef, ConsequenceTier, EntityIdRef, EvidenceHandle } from '@orimera/graph-client';
import type { ProposalDraft } from './draft.js';
import type { Intent } from './intent.js';
import { assertMultiSelectable, assertOfferable } from './tiers.js';

/**
 * THE TURN AND ITS OPTIONS (interaction-model.md 4.3).
 *
 * The architecture is taken from two verified game dialogue runtimes as an architectural
 * reference only:
 *
 *   ink: "a single ChoicePoint in the Story could potentially generate different Choices
 *   dynamically dependent on state, so they're separated."
 *   https://github.com/inkle/ink/blob/master/ink-engine-runtime/Choice.cs
 *
 *   Yarn Spinner hands the host an option set whose options carry a line, an id and an
 *   AVAILABILITY FLAG: "If this value is false, this option had a line condition on it that
 *   failed. The option will still be delivered to the game, but ... the game may decide to not
 *   allow the player to select it, or not offer it to the player at all."
 *   https://github.com/YarnSpinnerTool/YarnSpinner/blob/main/YarnSpinner/Dialogue.cs
 *
 * That shape is adopted exactly. The difference is that the story is not authored text: it is
 * generated per turn from the entity graph, which is why an option carries a `draft` and a
 * `tier` that no authored dialogue line would have.
 */

export type OptionKind =
  /** A soft prompt. Selecting it says something; it does not commit anything on its own. */
  | 'suggested_reply'
  /** Mutually exclusive. Commits on click (4.3). */
  | 'exclusive'
  /** Attribute gathering. Always with an explicit submit, and never above tier 1. */
  | 'multi_select'
  /** The always-available free input affordance. */
  | 'free_text'
  /** One of the four escapes. Always present, never penalized. */
  | 'escape';

/**
 * The four escapes (4.3). The fourth is the underrated one: "without it, a user whose situation
 * the system has mis-modelled has no move except to keep skipping, and skip is indistinguishable
 * from disinterest."
 */
export type EscapeKind =
  /** Recorded as an explicit `uncertain` assertion, which is DATA rather than a null. */
  | 'not_sure'
  /** The question is marked deferred. */
  | 'skip'
  /** The conversation is dismissed. No penalty. */
  | 'later'
  /** A negative signal on (intent, entity). "That is the wrong question." */
  | 'wrong_question';

export interface TurnOption {
  readonly optionId: string;
  readonly kind: OptionKind;
  /**
   * The stable message key. THE ID, KIND, TIER AND DRAFT ARE CONSTRUCTED BY DETERMINISTIC CODE
   * (4.4 stage 4); only `phrasing` is model-generated, and `applyPhrasing` in phrasing.ts is the
   * only function permitted to set it.
   */
  readonly textKey: string;
  /** Null until a model has phrased it. A null phrasing renders from `textKey`, never blank. */
  readonly phrasing: string | null;
  /** Yarn Spinner availability semantics. An unavailable option is still delivered. */
  readonly available: boolean;
  /** "mark the option unavailable WITH A REASON rather than hiding it" (4.4 stage 3). */
  readonly unavailableReasonKey: string | null;
  readonly tier: ConsequenceTier;
  /** Previewed on focus: hovering sets the manifest preview slot (7.2). Null for escapes. */
  readonly draft: ProposalDraft | null;
  readonly escape: EscapeKind | null;
}

export type ChoiceMode = 'single' | 'multi';

export interface ChoiceSet {
  readonly mode: ChoiceMode;
  readonly options: readonly TurnOption[];
  /** Multi mode always has an explicit submit; single mode commits on click (4.3). */
  readonly submitRequired: boolean;
}

/**
 * A turn (4.3): "an utterance with its evidence, an optional choice set, a free input affordance
 * for text, an always-present set of escapes, the subject anchor that drives Companion
 * placement, and the graph state version that invalidates it."
 *
 * Note what is NOT here: no screen position, no panel geometry, no element. The subject anchor
 * is an id; where the Companion materializes around it is 4.2's problem and lives in the
 * renderer binding, which this package may not import.
 */
export interface Turn {
  readonly turnId: string;
  readonly intent: Intent;
  readonly subjectEntityId: EntityIdRef | null;
  /** Drives Companion placement (4.2). An id, never a position. */
  readonly subjectAnchorId: AnchorIdRef | null;
  readonly utteranceKey: string;
  readonly utterance: string | null;
  readonly evidence: readonly EvidenceHandle[];
  readonly choiceSet: ChoiceSet | null;
  /** 4.3: "Free text input is always available." */
  readonly freeTextAllowed: boolean;
  readonly escapes: readonly TurnOption[];
  /** The version that invalidates this turn. */
  readonly stateVersion: number;
}

export class TurnValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnValidationError';
  }
}

/**
 * The choice mode rules from 4.3, enforced rather than remembered.
 *
 * "Single select when the answers are logically exclusive OR WHEN THE CHOICE CARRIES A TIER 2 OR
 * HIGHER CONSEQUENCE; it commits on click. Multi select for attribute gathering, always with an
 * explicit submit. Never mix a destructive or tier 2 option into a multi-select set, because a
 * blast-radius preview cannot be rendered for a set."
 *
 * Plus the tier 3 rule from 5.3, checked here because the dialogue panel is a surface and this
 * is the last place a turn passes through before it reaches one.
 */
export function validateTurn(turn: Turn): void {
  const set = turn.choiceSet;
  if (set !== null) {
    if (set.mode === 'multi' && !set.submitRequired) {
      throw new TurnValidationError(
        `turn ${turn.turnId}: a multi-select set must require an explicit submit`,
      );
    }
    if (set.mode === 'single' && set.submitRequired) {
      throw new TurnValidationError(
        `turn ${turn.turnId}: a single-select set commits on click and must not require a submit`,
      );
    }
    for (const option of set.options) {
      // Tier 3 may never be offered from the dialogue surface, in any phrasing (5.3).
      assertOfferable(option.tier, 'dialogue');
      if (set.mode === 'multi') assertMultiSelectable(option.tier);
      if (set.mode === 'multi' && option.kind !== 'multi_select' && option.kind !== 'escape') {
        throw new TurnValidationError(
          `turn ${turn.turnId}: option ${option.optionId} is ${option.kind} inside a multi set`,
        );
      }
      if (set.mode === 'single' && option.kind === 'multi_select') {
        throw new TurnValidationError(
          `turn ${turn.turnId}: option ${option.optionId} is multi_select inside a single set`,
        );
      }
    }
  }

  // The escapes are ALWAYS present. A turn that offers no way out is a questionnaire.
  if (turn.escapes.length === 0) {
    throw new TurnValidationError(`turn ${turn.turnId}: escapes are always present (4.3)`);
  }
  for (const escape of turn.escapes) {
    if (escape.kind !== 'escape' || escape.escape === null) {
      throw new TurnValidationError(
        `turn ${turn.turnId}: ${escape.optionId} is in the escape set but is not an escape`,
      );
    }
    if (escape.tier !== 0) {
      throw new TurnValidationError(
        `turn ${turn.turnId}: escape ${escape.optionId} must be tier 0; escapes are never penalized`,
      );
    }
  }
}

/** Every selectable option on a turn, choices and escapes together, in render order. */
export function allOptions(turn: Turn): readonly TurnOption[] {
  return [...(turn.choiceSet?.options ?? []), ...turn.escapes];
}

export function findOption(turn: Turn, optionId: string): TurnOption | null {
  return allOptions(turn).find((o) => o.optionId === optionId) ?? null;
}

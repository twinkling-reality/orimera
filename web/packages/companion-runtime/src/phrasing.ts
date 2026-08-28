import type { ChoiceSet, Turn, TurnOption } from './turn.js';
import { allOptions } from './turn.js';

/**
 * STAGE 4: "Only the phrasing is model-generated. The id, kind, consequence tier and proposed
 * update are constructed by deterministic code" (interaction-model.md 4.4).
 *
 * This file is the seam, and it is deliberately narrow. A model is handed `PhrasingRequest`,
 * which contains message keys and no consequences, and hands back `PhrasingResponse`, which
 * contains strings and nothing else. `applyPhrasing` copies those strings onto the turn and can
 * change nothing else, because there is nothing else in the response to copy.
 *
 * "A model that hallucinates a sentence produces an awkward question. A model that could author
 * a proposed update could silently merge two people."
 */

export interface PhrasingRequestOption {
  readonly optionId: string;
  readonly textKey: string;
  /** Present so the model can hedge appropriately, never so it can change it. */
  readonly available: boolean;
  readonly unavailableReasonKey: string | null;
}

export interface PhrasingRequest {
  readonly turnId: string;
  readonly utteranceKey: string;
  readonly options: readonly PhrasingRequestOption[];
}

export interface PhrasingResponse {
  readonly utterance: string;
  /** optionId -> phrasing. Ids the request did not contain are an error, not a no-op. */
  readonly options: Readonly<Record<string, string>>;
}

export class PhrasingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhrasingError';
  }
}

/**
 * What a model is allowed to see.
 *
 * Note what is NOT in here: no tier, no draft, no operations, no anchor ids, no entity ids. A
 * model cannot phrase around a consequence it was never shown, and it cannot be prompt-injected
 * into changing one it does not hold.
 */
export function phrasingRequest(turn: Turn): PhrasingRequest {
  return Object.freeze({
    turnId: turn.turnId,
    utteranceKey: turn.utteranceKey,
    options: Object.freeze(
      allOptions(turn).map((o) =>
        Object.freeze({
          optionId: o.optionId,
          textKey: o.textKey,
          available: o.available,
          unavailableReasonKey: o.unavailableReasonKey,
        }),
      ),
    ),
  });
}

function phrase(option: TurnOption, phrasings: Readonly<Record<string, string>>): TurnOption {
  const text = phrasings[option.optionId];
  if (text === undefined) return option;
  // Every field except `phrasing` is carried over by identity. This is the enforcement.
  return Object.freeze({ ...option, phrasing: text });
}

/**
 * Apply model phrasing to a turn.
 *
 * Throws on an option id the turn does not have. A silent no-op would let a model invent an
 * option that renders nowhere and looks, in a log, exactly like an option that was suppressed.
 * A missing phrasing is fine and stays null: the surface falls back to the message key, so a
 * model outage degrades to terse copy rather than to a blank panel.
 */
export function applyPhrasing(turn: Turn, response: PhrasingResponse): Turn {
  const known = new Set(allOptions(turn).map((o) => o.optionId));
  for (const id of Object.keys(response.options)) {
    if (!known.has(id)) {
      throw new PhrasingError(
        `phrasing response names option ${id}, which turn ${turn.turnId} does not offer`,
      );
    }
  }

  const choiceSet: ChoiceSet | null =
    turn.choiceSet === null
      ? null
      : Object.freeze({
          ...turn.choiceSet,
          options: Object.freeze(turn.choiceSet.options.map((o) => phrase(o, response.options))),
        });

  return Object.freeze({
    ...turn,
    utterance: response.utterance,
    choiceSet,
    escapes: Object.freeze(turn.escapes.map((o) => phrase(o, response.options))),
  });
}

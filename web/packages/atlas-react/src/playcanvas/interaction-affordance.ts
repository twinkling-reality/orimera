/**
 * The visible stages of one world interaction target.
 *
 * Candidate acquisition already has a protected 24-unit radius in atlas-core. The close boundary
 * deliberately reuses the source presentation's authored 4.2-unit "fully approached" threshold,
 * so the prompt and the memory resolve at the same spatial moment rather than inventing another
 * unrelated distance scale.
 */
export const FULL_INTERACTION_LABEL_DISTANCE = 4.2;

export type InteractionAffordanceStage = 'hidden' | 'signal' | 'key' | 'label';

export interface InteractionAffordanceInput {
  /** Nearest on-screen interactable inside the authored interaction radius. */
  readonly signalIndex: number | null;
  readonly candidateIndex: number | null;
  readonly focusedIndex: number | null;
  readonly focusedDistance: number | null;
}

/** A single target progresses from a silent sigil to a compact key and then its full verb. */
export function resolveInteractionAffordance(
  input: InteractionAffordanceInput,
): InteractionAffordanceStage {
  if (input.signalIndex === null) return 'hidden';
  if (
    input.candidateIndex !== input.signalIndex ||
    input.focusedIndex !== input.signalIndex
  ) return 'signal';
  if (input.focusedDistance === null) return 'key';
  return input.focusedDistance <= FULL_INTERACTION_LABEL_DISTANCE ? 'label' : 'key';
}

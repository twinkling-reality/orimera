/**
 * Update proposals (interaction-model.md 5.1).
 *
 * "No free-text answer and no choice ever mutates the graph directly. Every path, including a
 * single click on 'Yes, the same person', produces an update proposal, which is rendered, and
 * only an explicit confirmation commits it."
 */

export type ConsequenceTier = 0 | 1 | 2 | 3;

export type ProposalOrigin = 'user_utterance' | 'user_choice' | 'system_inference';

export interface ProposalOperation {
  readonly op: string;
  readonly tier: ConsequenceTier;
  /** Anchors this operation touches. Drives the tier 2 blast radius statement. */
  readonly affectedAnchorIds: readonly string[];
  readonly affectedIslandIds: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface UpdateProposal {
  readonly proposalId: string;
  readonly turnId: string;
  readonly origin: ProposalOrigin;
  /**
   * The user's words, verbatim.
   *
   * 5.1: "the VERBATIM RAW UTTERANCE, always retained and never paraphrased away". Empty only
   * when the origin is `system_inference`, which by definition has no utterance.
   */
  readonly rawUtterance: string;
  readonly operations: readonly ProposalOperation[];
  readonly provenanceSummary: string;
  readonly maxTier: ConsequenceTier;
  readonly reversible: boolean;
  /** The proposal expires when the graph moves past this version. */
  readonly expiresAtStateVersion: number;
}

export function maxTierOf(operations: readonly ProposalOperation[]): ConsequenceTier {
  let max: ConsequenceTier = 0;
  for (const op of operations) if (op.tier > max) max = op.tier;
  return max;
}

/**
 * Tier 2 is anything that merges, splits, affects more than six anchors, or spans more than one
 * island (interaction-model.md 5.3). Derived rather than declared, so an operation cannot be
 * mislabelled tier 1 to skip the blast radius preview.
 */
export const TIER_2_ANCHOR_THRESHOLD = 6;

export function deriveTier(
  op: 'name' | 'relate' | 'note' | 'reject_inference' | 'merge' | 'split' | 'delete',
  affectedAnchors: number,
  affectedIslands: number,
): ConsequenceTier {
  if (op === 'delete') return 3;
  if (op === 'merge' || op === 'split') return 2;
  if (affectedAnchors > TIER_2_ANCHOR_THRESHOLD || affectedIslands > 1) return 2;
  return 1;
}

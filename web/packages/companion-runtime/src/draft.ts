import type {
  AnchorIdRef,
  ConsequenceTier,
  EntityIdRef,
  EvidenceHandle,
  IslandIdRef,
  ProposalOperation,
  ProposalOrigin,
  UpdateProposal,
} from '@orimera/graph-client';
import { deriveTier, maxTierOf } from '@orimera/graph-client';

/**
 * PROPOSAL DRAFTING (interaction-model.md 5.1).
 *
 * "No free-text answer and no choice ever mutates the graph directly. Every path, including a
 * single click on 'Yes, the same person', produces an update proposal, which is rendered, and
 * only an explicit confirmation commits it."
 *
 * A DRAFT is what a dialogue option carries and what a free-text parse produces. It is not yet a
 * proposal: it has no turn id and no expiry, because the turn it belongs to may not exist yet
 * (an option's draft is built while the pool is being assembled) and the state version it
 * expires against is a property of the moment it is staged, not of the moment it was drafted.
 *
 * `finalizeDraft` turns one into an `UpdateProposal`. That is the only construction path, which
 * is what keeps the tier DERIVED (graph-client `deriveTier`) rather than declared by a caller.
 */

/** The operation vocabulary. Matches `deriveTier`'s domain in graph-client exactly. */
export type DraftOp = 'name' | 'relate' | 'note' | 'reject_inference' | 'merge' | 'split' | 'delete';

export interface DraftOperation {
  readonly op: DraftOp;
  readonly tier: ConsequenceTier;
  readonly affectedAnchorIds: readonly AnchorIdRef[];
  readonly affectedIslandIds: readonly IslandIdRef[];
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ProposalDraft {
  readonly draftId: string;
  readonly origin: ProposalOrigin;
  /**
   * 5.1: "the VERBATIM RAW UTTERANCE, always retained and never paraphrased away". Empty string
   * only when the origin is `system_inference`, which by definition has no utterance.
   */
  readonly rawUtterance: string;
  readonly subjectEntityId: EntityIdRef | null;
  readonly operations: readonly DraftOperation[];
  readonly maxTier: ConsequenceTier;
  readonly reversible: boolean;
  /** Message key. This package does not author user-facing prose; see `phrasing.ts`. */
  readonly provenanceSummaryKey: string;
  /** Evidence the captures already supply for this subject. Feeds band 2 of the confirmation. */
  readonly captureEvidence: readonly EvidenceHandle[];
}

/**
 * Build one operation with its tier derived from what it actually touches.
 *
 * The tier is not a parameter. That is the whole design: 5.3 defines tier 2 as "merge, split, or
 * any operation affecting more than six anchors or spanning more than one region", and if the
 * caller could pass a tier, a six-region rename could be labelled tier 1 and skip the preview.
 */
export function draftOperation(
  op: DraftOp,
  affectedAnchorIds: readonly AnchorIdRef[],
  affectedIslandIds: readonly IslandIdRef[],
  payload: Readonly<Record<string, unknown>>,
): DraftOperation {
  return Object.freeze({
    op,
    tier: deriveTier(op, affectedAnchorIds.length, affectedIslandIds.length),
    affectedAnchorIds: Object.freeze([...affectedAnchorIds]),
    affectedIslandIds: Object.freeze([...affectedIslandIds]),
    payload: Object.freeze({ ...payload }),
  });
}

export interface DraftInput {
  readonly draftId: string;
  readonly origin: ProposalOrigin;
  readonly rawUtterance: string;
  readonly subjectEntityId: EntityIdRef | null;
  readonly operations: readonly DraftOperation[];
  readonly provenanceSummaryKey: string;
  readonly captureEvidence?: readonly EvidenceHandle[];
}

/**
 * Reversibility, derived rather than asserted.
 *
 * 5.3 requires tier 2 reversibility to be "stated in words, AND TRUE: the merge is stored as an
 * assertion and a split restores the original partition exactly". Every operation in the
 * vocabulary is an event rather than a mutation (id-7, "all four operations are events, not
 * mutations"), so every one of them is reversible. `delete` is the exception the product has not
 * built yet and it is out of the MVP cut; it is marked irreversible here so that no surface can
 * promise an undo the system does not have.
 */
function isReversible(operations: readonly DraftOperation[]): boolean {
  return operations.every((o) => o.op !== 'delete');
}

export function makeDraft(input: DraftInput): ProposalDraft {
  if (input.operations.length === 0) {
    throw new RangeError('a proposal draft with no operations proposes nothing');
  }
  return Object.freeze({
    draftId: input.draftId,
    origin: input.origin,
    rawUtterance: input.rawUtterance,
    subjectEntityId: input.subjectEntityId,
    operations: Object.freeze([...input.operations]),
    maxTier: maxTierOf(input.operations),
    reversible: isReversible(input.operations),
    provenanceSummaryKey: input.provenanceSummaryKey,
    captureEvidence: Object.freeze([...(input.captureEvidence ?? [])]),
  });
}

/**
 * Draft -> proposal. The only construction path for an `UpdateProposal` in the front end.
 *
 * `expiresAtStateVersion` is the version the draft was computed against. graph-client's gate
 * refuses to commit a proposal whose expiry is behind the current version, because "a proposal
 * computed against a graph that has since changed describes a consequence that is no longer the
 * consequence".
 */
export function finalizeDraft(
  draft: ProposalDraft,
  proposalId: string,
  turnId: string,
  stateVersion: number,
): UpdateProposal {
  const operations: readonly ProposalOperation[] = draft.operations.map((o) =>
    Object.freeze({
      op: o.op,
      tier: o.tier,
      affectedAnchorIds: o.affectedAnchorIds,
      affectedIslandIds: o.affectedIslandIds,
      payload: o.payload,
    }),
  );
  return Object.freeze({
    proposalId,
    turnId,
    origin: draft.origin,
    rawUtterance: draft.rawUtterance,
    operations: Object.freeze(operations),
    provenanceSummary: draft.provenanceSummaryKey,
    maxTier: draft.maxTier,
    reversible: draft.reversible,
    expiresAtStateVersion: stateVersion,
  });
}

/** Union of every anchor a draft would touch. Drives the tier 2 blast radius statement. */
export function affectedAnchors(draft: ProposalDraft): readonly AnchorIdRef[] {
  const seen = new Set<AnchorIdRef>();
  for (const op of draft.operations) for (const a of op.affectedAnchorIds) seen.add(a);
  return [...seen];
}

export function affectedIslands(draft: ProposalDraft): readonly IslandIdRef[] {
  const seen = new Set<IslandIdRef>();
  for (const op of draft.operations) for (const i of op.affectedIslandIds) seen.add(i);
  return [...seen];
}

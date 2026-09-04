import type { UpdateProposal } from '@exulanica/graph-client';
import { ProposalGate } from '@exulanica/graph-client/mutations';
import type { ConfirmationAcknowledgement, ConfirmationSurface } from '../src/index.js';

/**
 * A gate with a recording transport.
 *
 * `committed` is the assertion surface for the invariant the whole package is built around:
 * nothing reaches the graph without an explicit confirmation. A test that wants to prove a write
 * did NOT happen asserts on this array being empty, which is a stronger claim than asserting
 * that a function returned a draft.
 */
export function recordingGate(initialStateVersion = 11): {
  gate: ProposalGate;
  committed: UpdateProposal[];
} {
  const committed: UpdateProposal[] = [];
  const gate = new ProposalGate(async (proposal) => {
    committed.push(proposal);
    return initialStateVersion + committed.length;
  }, initialStateVersion);
  return { gate, committed };
}

/** An acknowledgement that satisfies every requirement. Tests weaken one field at a time. */
export function fullAck(
  overrides: Partial<ConfirmationAcknowledgement> = {},
  surface: ConfirmationSurface = 'dialogue',
): ConfirmationAcknowledgement {
  return {
    surface,
    openForMs: 5_000,
    blastRadiusShown: true,
    livePreviewShown: true,
    typedDisplayName: null,
    mediaRetentionStatementShown: true,
    citationLossCountShown: true,
    ...overrides,
  };
}

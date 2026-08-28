/**
 * The commit transport: an approved update proposal becomes HTTP calls.
 *
 * The gate in `./index.ts` decides WHETHER a proposal may commit. This decides WHAT that means
 * on the wire, and the split matters: the gate is the guarantee and holds for code that was
 * never linted, while this is a translation and is allowed to be boring.
 *
 * **Two refusals happen here that the gate cannot make**, because they are about the shape of an
 * operation rather than about the proposal's standing:
 *
 *   - An operation whose `op` this transport does not know is refused rather than skipped. A
 *     proposal that half-applied would leave the graph in a state no event describes, and the
 *     interface would show the half it did.
 *   - An operation with a missing or malformed payload is refused before any call is made, so a
 *     multi-operation proposal cannot apply its first operation and then fail on its second.
 *
 * **The server does not take our word for any of it.** Every endpoint reached from here derives
 * the actor from the bearer token, refuses a confirmation that names a proposal which is not
 * pending, and enforces that a confirmed link carries a human decision. This transport being
 * correct is convenience; the guarantee is on the other side.
 */

import { Transport } from '../transport.js';
import type { ProposalOperation, UpdateProposal } from '../proposal.js';

export class UnsupportedOperationError extends Error {
  constructor(
    readonly op: string,
    readonly proposalId: string,
  ) {
    super(
      `refusing to commit proposal ${proposalId}: operation ${op} has no transport. A ` +
        'proposal that applied some of its operations would leave the graph in a state no ' +
        'event describes.',
    );
    this.name = 'UnsupportedOperationError';
  }
}

/** The operations this transport can carry, and the endpoint each one reaches. */
const ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  name: '/identity/name',
  confirm: '/identity/confirm',
  reject_inference: '/identity/reject',
  revoke: '/identity/revoke',
  merge: '/identity/merge',
  split: '/identity/split',
  undo: '/identity/undo',
});

/**
 * Build the `CommitTransport` the gate takes.
 *
 * Returns the new state version, which the gate stores and which then expires every proposal
 * computed against the old one. Read back from the server rather than incremented locally: a
 * client that guessed the next version would accept a proposal the server has moved past.
 */
export function httpCommitTransport(
  transport: Transport,
): (proposal: UpdateProposal) => Promise<number> {
  return async (proposal: UpdateProposal): Promise<number> => {
    for (const operation of proposal.operations) {
      if (!(operation.op in ENDPOINTS)) {
        throw new UnsupportedOperationError(operation.op, proposal.proposalId);
      }
      assertPayload(operation, proposal.proposalId);
    }
    for (const operation of proposal.operations) {
      await transport.postJson(ENDPOINTS[operation.op] as string, operation.payload);
    }
    const graph = await transport.getJson<{ state_version: number }>('/graph');
    return graph.state_version;
  };
}

/**
 * Refuse a payload that is missing what its endpoint requires, before anything is sent.
 *
 * Checked here rather than left to the server's 422, because the server answers one request at a
 * time and a proposal is all-or-nothing. Finding out on the second operation that it was
 * malformed is finding out too late.
 */
function assertPayload(operation: ProposalOperation, proposalId: string): void {
  const required: Readonly<Record<string, readonly string[]>> = {
    name: ['occurrence_id', 'display_name'],
    confirm: ['occurrence_id', 'entity_id'],
    reject_inference: ['occurrence_id', 'entity_id'],
    revoke: ['occurrence_id'],
    merge: ['sources', 'target'],
    split: ['entity_id', 'occurrence_ids'],
    undo: ['event_id'],
  };
  for (const field of required[operation.op] ?? []) {
    if (operation.payload[field] === undefined) {
      throw new UnsupportedOperationError(
        `${operation.op} (missing ${field})`,
        proposalId,
      );
    }
  }
}

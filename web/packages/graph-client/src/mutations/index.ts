import type { UpdateProposal } from '../proposal.js';

/**
 * THE MUTATION GATE.
 *
 * architecture-overview.md 1.1: "graph-client is the only module permitted to mutate, and it
 * rejects any mutation whose proposal id is not in the pending proposal set. THIS IS A RUNTIME
 * CHECK, NOT A LINT RULE. It exists because the product's epistemic guarantee is that the system
 * may organize on a guess but never assert on one, and that guarantee is worthless if any UI
 * component can write an assertion."
 *
 * Why a runtime check and not a type: a lint rule protects code that was linted. This gate
 * protects code that was not, including code that does not exist yet, and it fails loudly at the
 * moment of the write rather than at review time.
 *
 * The transport is in `./transport.ts`. The gate decides WHETHER a proposal may commit and
 * the transport decides WHAT that means on the wire; keeping them apart is what lets the gate
 * be tested with no server and the transport be replaced without touching the guarantee.
 */

export class ProposalGateError extends Error {
  constructor(
    message: string,
    readonly proposalId: string,
  ) {
    super(message);
    this.name = 'ProposalGateError';
  }
}

export interface CommitResult {
  readonly proposalId: string;
  readonly stateVersion: number;
}

export type CommitTransport = (proposal: UpdateProposal) => Promise<number>;

/**
 * Holds the pending proposal set. Nothing commits that is not in here, and a proposal leaves the
 * set the moment it commits, so a double submit is rejected rather than applied twice.
 */
export class ProposalGate {
  readonly #pending = new Map<string, UpdateProposal>();
  #stateVersion: number;

  constructor(
    private readonly transport: CommitTransport,
    initialStateVersion: number,
  ) {
    this.#stateVersion = initialStateVersion;
  }

  get stateVersion(): number {
    return this.#stateVersion;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Staging is what the confirmation surface renders. It does not write anything. */
  stage(proposal: UpdateProposal): void {
    this.#pending.set(proposal.proposalId, proposal);
  }

  /** Cancel. Restores instantly because nothing was mutated (interaction-model.md 5.3). */
  discard(proposalId: string): void {
    this.#pending.delete(proposalId);
  }

  isPending(proposalId: string): boolean {
    return this.#pending.has(proposalId);
  }

  /**
   * The only write path in the front end.
   *
   * Three refusals, in order:
   *   1. Not in the pending set. This is the guarantee itself.
   *   2. Expired against the current state version. A proposal computed against a graph that has
   *      since changed describes a consequence that is no longer the consequence.
   *   3. Tier 3. "Never offered as a dialogue option and never offered by Companion initiative.
   *      Reachable only from the World Index entity detail view" (5.3), and tier 3 is out of the
   *      MVP cut. The rule stands regardless, so that adding it later cannot smuggle it in.
   */
  async commit(proposalId: string): Promise<CommitResult> {
    const proposal = this.#pending.get(proposalId);
    if (proposal === undefined) {
      throw new ProposalGateError(
        `refusing to mutate: proposal ${proposalId} is not in the pending set`,
        proposalId,
      );
    }
    if (proposal.expiresAtStateVersion < this.#stateVersion) {
      this.#pending.delete(proposalId);
      throw new ProposalGateError(
        `refusing to mutate: proposal ${proposalId} expired at state version ` +
          `${proposal.expiresAtStateVersion}, graph is at ${this.#stateVersion}`,
        proposalId,
      );
    }
    if (proposal.maxTier === 3) {
      throw new ProposalGateError(
        `refusing to mutate: tier 3 operations are out of the MVP cut and are not reachable from this gate`,
        proposalId,
      );
    }

    const nextVersion = await this.transport(proposal);
    this.#pending.delete(proposalId);
    this.#stateVersion = nextVersion;
    return { proposalId, stateVersion: nextVersion };
  }
}

export { UnsupportedOperationError, httpCommitTransport } from './transport.js';

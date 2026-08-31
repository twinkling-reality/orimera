/**
 * Typed handoff for an upstream conversational proposal service.
 *
 * This inbox does not call a model, store conversation text, or translate prose into style data.
 * A future authenticated service supplies the already-structured, provenance-bearing proposal;
 * Atlas still validates it through the local recipe registry and backend preview lifecycle.
 */

import type { UpstreamWorldStyleProposal } from './world-style-api.js';

export type WorldStyleProposalListener = (
  proposal: UpstreamWorldStyleProposal,
) => void | Promise<void>;

export class WorldStyleProposalInbox {
  readonly #listeners = new Set<WorldStyleProposalListener>();

  subscribe(listener: WorldStyleProposalListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** True only when an Atlas integration was present to receive the proposal. */
  submit(proposal: UpstreamWorldStyleProposal): boolean {
    if (this.#listeners.size === 0) return false;
    for (const listener of this.#listeners) void listener(proposal);
    return true;
  }
}

export const worldStyleProposalInbox = new WorldStyleProposalInbox();

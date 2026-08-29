/**
 * @orimera/graph-client
 *
 * Entity graph reads, the assertion log and evidence resolution. This package sits UNDER
 * everything: it may not import atlas-core, atlas-react, companion-runtime or world-index
 * (architecture-overview.md 1.1), and `.dependency-cruiser.cjs` enforces that.
 *
 * Mutations live behind a second entry point, `@orimera/graph-client/mutations`, so that
 * "atlas-react forbids graph mutations" is a path a lint rule can name rather than a habit.
 *
 * The transport is real. `client.ts` speaks to the HTTP API and adapts its payloads into the
 * read model below, and the adapter is the single place where the difference between what the
 * read model asks for and what the server can answer is written down. The read model did not
 * have to change to make the transport real, which is what the boundary was for.
 */

export type {
  ClientOptions,
  GraphPayload,
  IslandOf,
  SelectionCapture,
  SelectionSupport,
  SelectionView,
} from './client.js';
export { OrimeraClient, adaptSnapshot } from './client.js';

export type { ApiProblem, TransportOptions } from './transport.js';
export { ApiError, Transport, toApiError } from './transport.js';

export type {
  ConsequenceTier,
  ProposalOperation,
  ProposalOrigin,
  UpdateProposal,
} from './proposal.js';
export { TIER_2_ANCHOR_THRESHOLD, deriveTier, maxTierOf } from './proposal.js';

export type {
  AnchorIdRef,
  AssertionIdRef,
  AssertionKind,
  AssertionProducer,
  AssertionStatus,
  AssertionView,
  CitationModality,
  ConfidenceBand,
  ContradictionView,
  EntityIdRef,
  EntityKind,
  EntityRecord,
  EvidenceHandle,
  EvidenceRegion,
  EvidenceResolver,
  GraphSnapshot,
  HistoryEvent,
  HistoryEventType,
  IndexStatus,
  IslandIdRef,
  IslandRecord,
  LinkState,
  MatchProposalView,
  OccurrenceIdRef,
  OccurrenceKind,
  OccurrenceRecord,
  ReconstructionRungRef,
  RelationView,
  ResolvedEvidence,
} from './read-model.js';
export {
  entityById,
  hasActiveAssertion,
  isNeverSame,
  knowledgeSources,
  occurrencesOf,
  openQuestionCount,
} from './read-model.js';

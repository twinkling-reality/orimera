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
 * STATUS: the transport is a stub owned by another workstream. The read MODEL below is real,
 * because companion-runtime and world-index both build against it and neither may define it
 * (the arrow between them would point the wrong way). The mutation gate is real for the reason
 * stated in mutations/index.ts: the module contract names it as a runtime check.
 */

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
  LinkState,
  MatchProposalView,
  OccurrenceIdRef,
  OccurrenceRecord,
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

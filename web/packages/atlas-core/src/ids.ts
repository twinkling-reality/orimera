import type { Brand } from './brand.js';

/**
 * Ids are branded strings. They are opaque to atlas-core: it never parses one, never orders by
 * one semantically, and never constructs one from graph data. Sorting by id happens only as a
 * deterministic tie-break (layout/solver.ts), which is why lexicographic order is enough.
 */
export type IslandId = Brand<string, 'IslandId'>;
export type AnchorId = Brand<string, 'AnchorId'>;
export type EntityId = Brand<string, 'EntityId'>;
export type OccurrenceId = Brand<string, 'OccurrenceId'>;
export type ManifestId = Brand<string, 'ManifestId'>;
export type SegmentId = Brand<number, 'SegmentId'>;

/**
 * An evidence reference is an OPAQUE HANDLE here, deliberately.
 *
 * interaction-model.md 3.4: "The interaction layer treats an evidence reference as an opaque
 * handle and never constructs or parses one; it passes it to the evidence resolver and renders
 * what comes back." The real address shape lives in domain-and-evidence-model.md 1.5 and is
 * owned by graph-client.
 */
export type EvidenceRef = Brand<string, 'EvidenceRef'>;

export const islandId = (v: string): IslandId => v as IslandId;
export const anchorId = (v: string): AnchorId => v as AnchorId;
export const entityId = (v: string): EntityId => v as EntityId;
export const occurrenceId = (v: string): OccurrenceId => v as OccurrenceId;
export const manifestId = (v: string): ManifestId => v as ManifestId;
export const segmentId = (v: number): SegmentId => v as SegmentId;
export const evidenceRef = (v: string): EvidenceRef => v as EvidenceRef;

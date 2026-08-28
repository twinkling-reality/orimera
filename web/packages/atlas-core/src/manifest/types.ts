import type { EmphasisLevel } from '../emphasis.js';
import type { AnchorId, EntityId, EvidenceRef, IslandId, ManifestId } from '../ids.js';

/**
 * The view manifest: "the data structure the whole feature turns on" (interaction-model.md 7.2).
 *
 * Recomposition is a PURE VIEW TRANSFORMATION over an unchanged, never-reloaded scene graph
 * (7.1). Geometry, island placements and anchor positions never change in response to a query.
 * What changes is a per-object emphasis scalar plus a set of derived overlay elements.
 *
 * Two of the four anti-disorientation rules in 7.3 are enforced structurally by this type rather
 * than by a runtime check, because a structural guarantee cannot be forgotten:
 *
 *   Rule 2, never move geometry: a manifest has no field that can express a position, so a
 *   query CANNOT translate an island. There is nothing to review.
 *   Rule 3, the camera does not move on a recomposition: a manifest has no camera field either.
 *
 * Rules 1 and 4 are not expressible in the type system and are enforced at runtime in
 * `validateManifest`.
 */

export type QueryKind =
  | 'entity'
  | 'conjunction'
  | 'disjunction'
  | 'temporal'
  | 'natural-language'
  /** The ONLY kind permitted to use `hidden`. Reserved for content the user deleted (7.3 rule 1). */
  | 'deleted-content'
  /** The ephemeral preview slot: a tier 2 blast radius, or a hovered dialogue option (5.3, 7.2). */
  | 'preview';

export interface ManifestQuery {
  readonly kind: QueryKind;
  /** Entities the query is about. Drives the caption and the undo label. */
  readonly entityIds: readonly EntityId[];
}

export interface ManifestEmphasis {
  /**
   * Sparse. Anchors absent from this map take `defaultLevel`.
   *
   * 7.2: "muted while a query is active, normal otherwise". A one-entity query therefore mutes
   * roughly the whole world with two small maps, which is the reason this is sparse.
   */
  readonly anchors: ReadonlyMap<AnchorId, EmphasisLevel>;
  readonly islands: ReadonlyMap<IslandId, EmphasisLevel>;
  readonly defaultLevel: EmphasisLevel;
}

/**
 * Thread style and the AND/OR distinction (interaction-model.md 7.4).
 *
 * "Solid means these two were together here, dashed means only one of them was here." That
 * distinction is the reason for having a 3D interface at all, so `dashed` is a required field
 * rather than an optional flag.
 */
export type ThreadStyle =
  /** One entity, linked across islands. */
  | 'identity'
  /** A AND B, and both were present in the same capture within the co-presence window. */
  | 'copresence'
  /** A AND B, but only one of them was here. Always dashed. */
  | 'single-presence'
  /** An unconfirmed candidate link. Always dashed, and it must LOOK unconfirmed. */
  | 'candidate';

export interface ManifestThread {
  readonly from: AnchorId;
  readonly to: AnchorId;
  readonly entityId: EntityId;
  /** 0..1. Drives line thickness; on the Atlas Map, thickness is shared confirmed entities. */
  readonly strength: number;
  readonly style: ThreadStyle;
  /**
   * Solid or dashed. Redundant with `style` for three of the four styles by construction, and
   * `buildThread` derives it, but it is stored because the renderer reads it directly per line
   * segment and must not re-derive semantics in a shader.
   */
  readonly dashed: boolean;
  /**
   * Palette slot, not a colour. A OR B renders "in two distinguishable hues" (7.4); which hues
   * is a theme decision that does not belong in atlas-core.
   */
  readonly hue: number;
}

export interface ManifestCaption {
  readonly anchor: AnchorId;
  /** Message key. atlas-core does not author user-facing prose; see the note on `ManifestSummary`. */
  readonly key: string;
  readonly evidence: readonly EvidenceRef[];
}

/** A clickable count in the summary. 7.4: "Each count clickable to swap the manifest." */
export interface SummaryCount {
  readonly key: string;
  readonly value: number;
  /** Entities the swapped-to manifest would be about, or null when the count is not clickable. */
  readonly swapTo: readonly EntityId[] | null;
}

/**
 * The summary caption, as structured counts rather than a sentence.
 *
 * atlas-core deliberately does not author prose. Two reasons, both from the documents: the exact
 * captions in 7.4 are counts and the counts must be individually clickable, and the Companion's
 * safety boundary (4.4) is "the model writes words, the code writes consequences" - so the code
 * side of that boundary should be emitting consequences, not words.
 */
export interface ManifestSummary {
  readonly key: string;
  readonly counts: readonly SummaryCount[];
  readonly evidence: readonly EvidenceRef[];
}

export interface ManifestTransition {
  /** Milliseconds. Ignored when style is 'instant'. */
  readonly durationMs: number;
  /** 'instant' is what `prefers-reduced-motion` selects (interaction-model.md 7.3 rule 4, 9). */
  readonly style: 'cross-fade' | 'instant';
}

export interface ViewManifest {
  readonly manifestId: ManifestId;
  readonly createdAt: number;
  /** The graph version this was computed against. A mismatch makes the frame stale, not invalid. */
  readonly stateVersion: number;
  readonly query: ManifestQuery;
  readonly emphasis: ManifestEmphasis;
  readonly threads: readonly ManifestThread[];
  /** At most 6 (interaction-model.md 3.4 overlay caps, 7.2). Enforced in `validateManifest`. */
  readonly captions: readonly ManifestCaption[];
  /** Ordered. Drives Tab cycling and the four edge chevrons. */
  readonly focusCandidates: readonly AnchorId[];
  readonly summary: ManifestSummary;
  readonly transition: ManifestTransition;
}

/** interaction-model.md 3.4: hard caps on the DOM overlay. */
export const MAX_CAPTIONS = 6;
export const MAX_EDGE_CHEVRONS = 4;
export const MAX_FOCUS_LABELS = 1;

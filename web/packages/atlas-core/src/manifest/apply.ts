import type { EmphasisLevel } from '../emphasis.js';
import { EMPHASIS_SCALAR, isInteractable, isLabelable } from '../emphasis.js';
import type { AnchorId, IslandId } from '../ids.js';
import type { AnchorTable } from '../scene.js';
import type { ViewManifest } from './types.js';
import { MAX_CAPTIONS } from './types.js';

/**
 * Applying a view manifest.
 *
 * NON-DESTRUCTIVE, and that word has a precise meaning here: the scene graph, the anchor table
 * and the manifest are all treated as read-only inputs and are never written. What is produced
 * is a separate emphasis frame of typed arrays. Cancelling a tier 2 preview "restores instantly
 * because nothing was mutated" (interaction-model.md 5.3) is a property of this shape, not of
 * discipline.
 *
 * Performance contract (7.5): applying a manifest is a tight numeric loop over anchors, safe to
 * run on every hover. `applyViewManifestInto` reuses caller-owned buffers so the hover path
 * allocates nothing; `applyViewManifest` allocates fresh ones for a first frame or a test.
 */

export const LEVEL_ORDER: readonly EmphasisLevel[] = [
  'primary',
  'secondary',
  'normal',
  'muted',
  'hidden',
];

const LEVEL_INDEX: Readonly<Record<EmphasisLevel, number>> = Object.freeze({
  primary: 0,
  secondary: 1,
  normal: 2,
  muted: 3,
  hidden: 4,
});

/** Caller-owned typed arrays, sized to the anchor table. */
export interface EmphasisBuffers {
  readonly anchorEmphasis: Float32Array;
  readonly anchorLevel: Uint8Array;
  readonly anchorInteractable: Uint8Array;
  readonly anchorLabelable: Uint8Array;
  readonly islandEmphasis: Float32Array;
  readonly islandLevel: Uint8Array;
}

export function allocateEmphasisBuffers(table: AnchorTable): EmphasisBuffers {
  return {
    anchorEmphasis: new Float32Array(table.count),
    anchorLevel: new Uint8Array(table.count),
    anchorInteractable: new Uint8Array(table.count),
    anchorLabelable: new Uint8Array(table.count),
    islandEmphasis: new Float32Array(table.islandIds.length),
    islandLevel: new Uint8Array(table.islandIds.length),
  };
}

export interface EmphasisFrame extends EmphasisBuffers {
  readonly manifest: ViewManifest;
  /**
   * True when the manifest was computed against a different graph state version than the scene.
   *
   * 7.5: "If the graph changes underneath (a merge commits), a stale manifest is recomputed, and
   * if recomputation materially changes the result the caption says so rather than the world
   * silently rearranging." Staleness is reported, never silently ignored and never thrown on.
   */
  readonly stale: boolean;
  /** Ids the manifest referenced that are not in this scene. Surfaced rather than swallowed. */
  readonly unresolvedAnchors: readonly AnchorId[];
  readonly unresolvedIslands: readonly IslandId[];
}

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Runtime enforcement of the two anti-disorientation rules the type system cannot express.
 *
 * Rule 1 (7.3): "Never use hidden for query results. Mute, do not hide." The world's shape must
 * stay constant so spatial memory survives across queries. `hidden` is reserved for content the
 * user deleted. This is a throw and not a warning because a query that hides half the world is a
 * product defect that would ship silently otherwise.
 *
 * Rule 4 (7.3, restated in 9): under reduced motion the transition is instant and "the summary
 * caption becomes MANDATORY, because the change now has to be carried verbally". An instant
 * transition with an empty summary loses information that lived only in the animation.
 */
export function validateManifest(manifest: ViewManifest): void {
  if (manifest.query.kind !== 'deleted-content') {
    for (const [id, level] of manifest.emphasis.anchors) {
      if (level === 'hidden') {
        throw new ManifestValidationError(
          `anchor ${id} is hidden by a ${manifest.query.kind} manifest; query results mute, they do not hide`,
          'anti-disorientation-1',
        );
      }
    }
    for (const [id, level] of manifest.emphasis.islands) {
      if (level === 'hidden') {
        throw new ManifestValidationError(
          `island ${id} is hidden by a ${manifest.query.kind} manifest; query results mute, they do not hide`,
          'anti-disorientation-1',
        );
      }
    }
    if (manifest.emphasis.defaultLevel === 'hidden') {
      throw new ManifestValidationError(
        'a query manifest may not default to hidden',
        'anti-disorientation-1',
      );
    }
  }

  if (manifest.transition.style === 'instant' && manifest.summary.key === '') {
    throw new ManifestValidationError(
      'an instant transition must carry a summary caption: under reduced motion the caption is what replaces the animation',
      'anti-disorientation-4',
    );
  }

  if (manifest.captions.length > MAX_CAPTIONS) {
    throw new ManifestValidationError(
      `${manifest.captions.length} captions exceeds the overlay cap of ${MAX_CAPTIONS}`,
      'overlay-cap',
    );
  }
}

/** The hot path. Writes into caller-owned buffers; touches nothing else. */
export function applyViewManifestInto(
  table: AnchorTable,
  manifest: ViewManifest,
  out: EmphasisBuffers,
  sceneStateVersion: number,
): EmphasisFrame {
  validateManifest(manifest);

  const defaultLevel = manifest.emphasis.defaultLevel;
  const defaultScalar = EMPHASIS_SCALAR[defaultLevel];
  const defaultIndex = LEVEL_INDEX[defaultLevel];
  const defaultInteract = isInteractable(defaultLevel) ? 1 : 0;
  const defaultLabel = isLabelable(defaultLevel) ? 1 : 0;

  out.anchorEmphasis.fill(defaultScalar);
  out.anchorLevel.fill(defaultIndex);
  out.anchorInteractable.fill(defaultInteract);
  out.anchorLabelable.fill(defaultLabel);
  out.islandEmphasis.fill(defaultScalar);
  out.islandLevel.fill(defaultIndex);

  const unresolvedAnchors: AnchorId[] = [];
  for (const [id, level] of manifest.emphasis.anchors) {
    const i = table.indexOf.get(id);
    if (i === undefined) {
      unresolvedAnchors.push(id);
      continue;
    }
    out.anchorEmphasis[i] = EMPHASIS_SCALAR[level];
    out.anchorLevel[i] = LEVEL_INDEX[level];
    out.anchorInteractable[i] = isInteractable(level) ? 1 : 0;
    out.anchorLabelable[i] = isLabelable(level) ? 1 : 0;
  }

  const unresolvedIslands: IslandId[] = [];
  for (const [id, level] of manifest.emphasis.islands) {
    const i = table.islandIndexOf.get(id);
    if (i === undefined) {
      unresolvedIslands.push(id);
      continue;
    }
    out.islandEmphasis[i] = EMPHASIS_SCALAR[level];
    out.islandLevel[i] = LEVEL_INDEX[level];
  }

  return Object.freeze({
    ...out,
    manifest,
    stale: manifest.stateVersion !== sceneStateVersion,
    unresolvedAnchors: Object.freeze(unresolvedAnchors),
    unresolvedIslands: Object.freeze(unresolvedIslands),
  });
}

/** Allocating variant, for a first frame or a test. */
export function applyViewManifest(
  table: AnchorTable,
  manifest: ViewManifest,
  sceneStateVersion: number,
): EmphasisFrame {
  return applyViewManifestInto(table, manifest, allocateEmphasisBuffers(table), sceneStateVersion);
}

/** The neutral frame: nothing emphasised, nothing muted. What the world looks like with no query. */
export function neutralEmphasis(table: AnchorTable): EmphasisBuffers {
  const buffers = allocateEmphasisBuffers(table);
  buffers.anchorEmphasis.fill(EMPHASIS_SCALAR.normal);
  buffers.anchorLevel.fill(LEVEL_INDEX.normal);
  buffers.anchorInteractable.fill(1);
  buffers.anchorLabelable.fill(1);
  buffers.islandEmphasis.fill(EMPHASIS_SCALAR.normal);
  buffers.islandLevel.fill(LEVEL_INDEX.normal);
  return buffers;
}

export function levelAt(frame: EmphasisBuffers, anchorIndex: number): EmphasisLevel {
  return LEVEL_ORDER[frame.anchorLevel[anchorIndex]!]!;
}

import type { EmphasisLevel } from '../emphasis.js';
import type { AnchorId, EntityId, EvidenceRef, IslandId, ManifestId } from '../ids.js';
import type { AnchorTable } from '../scene.js';
import type {
  ManifestThread,
  ThreadStyle,
  ViewManifest,
} from './types.js';
import { MAX_CAPTIONS, MAX_EDGE_CHEVRONS } from './types.js';

/**
 * Manifest builders for the three query shapes in interaction-model.md 7.4.
 *
 * These take an ALREADY RESOLVED query result. atlas-core does not query the entity graph and
 * has no way to: it holds no transport and imports no graph-client. Resolution is graph-client's
 * job, presentation is this one's, and the seam between them is these input types.
 *
 * The reason the builders exist at all, rather than letting each caller assemble a manifest by
 * hand, is 7.4: "This is easy to get wrong and it matters." AND and OR must look different, not
 * merely count differently. Encoding solid-versus-dashed once, here, is the difference between a
 * rule and a hope.
 */

export interface ManifestIdentity {
  readonly manifestId: ManifestId;
  readonly createdAt: number;
  readonly stateVersion: number;
  /** Reduced motion selects 'instant', which makes the summary caption mandatory. */
  readonly reducedMotion: boolean;
}

const CROSS_FADE_MS = 400;

function transition(reducedMotion: boolean): ViewManifest['transition'] {
  return reducedMotion
    ? { durationMs: 0, style: 'instant' }
    : { durationMs: CROSS_FADE_MS, style: 'cross-fade' };
}

function thread(
  from: AnchorId,
  to: AnchorId,
  entity: EntityId,
  style: ThreadStyle,
  strength: number,
  hue: number,
): ManifestThread {
  return Object.freeze({
    from,
    to,
    entityId: entity,
    strength,
    style,
    // Solid means "these two were together here". Derived once, here, and never re-derived.
    dashed: style === 'single-presence' || style === 'candidate',
    hue,
  });
}

/** One anchor per island, in table order, so the identity thread reads as a chain across islands. */
function chainAcrossIslands(
  table: AnchorTable,
  anchors: readonly AnchorId[],
): readonly AnchorId[] {
  const seen = new Set<IslandId>();
  const picked: Array<{ index: number; id: AnchorId }> = [];
  for (const id of anchors) {
    const i = table.indexOf.get(id);
    if (i === undefined) continue;
    const island = table.anchors[i]!.islandId;
    if (seen.has(island)) continue;
    seen.add(island);
    picked.push({ index: i, id });
  }
  picked.sort((a, b) => a.index - b.index);
  return picked.map((p) => p.id);
}

function emphasisMap(
  entries: readonly (readonly [AnchorId, EmphasisLevel])[],
): ReadonlyMap<AnchorId, EmphasisLevel> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------------------------
// One entity: "Appears in 14 occurrences across 3 regions."
// ---------------------------------------------------------------------------------------------

export interface EntityQueryResult {
  readonly entityId: EntityId;
  /** Anchors of the entity itself. */
  readonly anchors: readonly AnchorId[];
  /** Anchors of co-occurring entities. Secondary emphasis. */
  readonly coOccurring: readonly AnchorId[];
  readonly islands: readonly IslandId[];
  readonly occurrenceCount: number;
  readonly evidence: readonly EvidenceRef[];
}

export function buildEntityManifest(
  id: ManifestIdentity,
  table: AnchorTable,
  result: EntityQueryResult,
): ViewManifest {
  const anchors: Array<readonly [AnchorId, EmphasisLevel]> = [];
  for (const a of result.anchors) anchors.push([a, 'primary'] as const);
  for (const a of result.coOccurring) {
    if (!result.anchors.includes(a)) anchors.push([a, 'secondary'] as const);
  }

  const chain = chainAcrossIslands(table, result.anchors);
  const threads: ManifestThread[] = [];
  for (let i = 1; i < chain.length; i += 1) {
    threads.push(thread(chain[i - 1]!, chain[i]!, result.entityId, 'identity', 1, 0));
  }

  const manifest: ViewManifest = {
    manifestId: id.manifestId,
    createdAt: id.createdAt,
    stateVersion: id.stateVersion,
    query: { kind: 'entity', entityIds: [result.entityId] },
    emphasis: {
      anchors: emphasisMap(anchors),
      islands: new Map(result.islands.map((i) => [i, 'secondary' as EmphasisLevel])),
      // "muted while a query is active, normal otherwise" (7.2). Muted, never hidden (7.3 rule 1).
      defaultLevel: 'muted',
    },
    threads: Object.freeze(threads),
    captions: Object.freeze([]),
    focusCandidates: Object.freeze(result.anchors.slice(0, MAX_EDGE_CHEVRONS * MAX_CAPTIONS)),
    summary: {
      key: 'summary.entity',
      counts: Object.freeze([
        { key: 'count.occurrences', value: result.occurrenceCount, swapTo: null },
        { key: 'count.regions', value: result.islands.length, swapTo: null },
      ]),
      evidence: result.evidence,
    },
    transition: transition(id.reducedMotion),
  };
  return Object.freeze(manifest);
}

// ---------------------------------------------------------------------------------------------
// A OR B: both sets primary, no secondary, per-entity threads in two distinguishable hues.
// ---------------------------------------------------------------------------------------------

export interface DisjunctionQueryResult {
  readonly a: EntityQueryResult;
  readonly b: EntityQueryResult;
}

export function buildDisjunctionManifest(
  id: ManifestIdentity,
  table: AnchorTable,
  result: DisjunctionQueryResult,
): ViewManifest {
  const anchors: Array<readonly [AnchorId, EmphasisLevel]> = [];
  for (const a of result.a.anchors) anchors.push([a, 'primary'] as const);
  for (const a of result.b.anchors) anchors.push([a, 'primary'] as const);

  const threads: ManifestThread[] = [];
  // Hue 0 and hue 1. 7.4: OR renders "per-entity threads in two distinguishable hues".
  for (const [side, hue] of [
    [result.a, 0],
    [result.b, 1],
  ] as const) {
    const chain = chainAcrossIslands(table, side.anchors);
    for (let i = 1; i < chain.length; i += 1) {
      threads.push(thread(chain[i - 1]!, chain[i]!, side.entityId, 'identity', 1, hue));
    }
  }

  const islands = new Map<IslandId, EmphasisLevel>();
  for (const i of [...result.a.islands, ...result.b.islands]) islands.set(i, 'secondary');

  const manifest: ViewManifest = {
    manifestId: id.manifestId,
    createdAt: id.createdAt,
    stateVersion: id.stateVersion,
    query: { kind: 'disjunction', entityIds: [result.a.entityId, result.b.entityId] },
    emphasis: { anchors: emphasisMap(anchors), islands, defaultLevel: 'muted' },
    threads: Object.freeze(threads),
    captions: Object.freeze([]),
    focusCandidates: Object.freeze([...result.a.anchors, ...result.b.anchors]),
    summary: {
      key: 'summary.disjunction',
      counts: Object.freeze([
        { key: 'count.withA', value: result.a.occurrenceCount, swapTo: [result.a.entityId] },
        { key: 'count.withB', value: result.b.occurrenceCount, swapTo: [result.b.entityId] },
      ]),
      evidence: Object.freeze([...result.a.evidence, ...result.b.evidence]),
    },
    transition: transition(id.reducedMotion),
  };
  return Object.freeze(manifest);
}

// ---------------------------------------------------------------------------------------------
// A AND B (together). The one that is easy to get wrong.
// ---------------------------------------------------------------------------------------------

export interface ConjunctionQueryResult {
  readonly a: EntityId;
  readonly b: EntityId;
  /**
   * Anchors where BOTH entities are present within the co-presence window in the same capture.
   * Resolved relationally from confirmed link rows by graph-client, never from a nearest
   * neighbour result (architecture-overview.md 3: "ANN is used for recall and ranking only,
   * never for set membership").
   */
  readonly bothPresent: readonly (readonly [AnchorId, AnchorId])[];
  /** Anchors with exactly one of them. Secondary emphasis, dashed threads. */
  readonly aOnly: readonly AnchorId[];
  readonly bOnly: readonly AnchorId[];
  readonly islands: readonly IslandId[];
  readonly evidence: readonly EvidenceRef[];
}

export function buildConjunctionManifest(
  id: ManifestIdentity,
  table: AnchorTable,
  result: ConjunctionQueryResult,
): ViewManifest {
  const anchors: Array<readonly [AnchorId, EmphasisLevel]> = [];
  for (const [x, y] of result.bothPresent) {
    anchors.push([x, 'primary'] as const);
    anchors.push([y, 'primary'] as const);
  }
  for (const a of result.aOnly) anchors.push([a, 'secondary'] as const);
  for (const b of result.bOnly) anchors.push([b, 'secondary'] as const);

  const threads: ManifestThread[] = [];
  // SOLID for co-presence: "these two were together here".
  for (const [x, y] of result.bothPresent) {
    threads.push(thread(x, y, result.a, 'copresence', 1, 0));
  }
  // DASHED for single presence: "only one of them was here".
  const aChain = chainAcrossIslands(table, result.aOnly);
  for (let i = 1; i < aChain.length; i += 1) {
    threads.push(thread(aChain[i - 1]!, aChain[i]!, result.a, 'single-presence', 0.5, 0));
  }
  const bChain = chainAcrossIslands(table, result.bOnly);
  for (let i = 1; i < bChain.length; i += 1) {
    threads.push(thread(bChain[i - 1]!, bChain[i]!, result.b, 'single-presence', 0.5, 1));
  }

  const manifest: ViewManifest = {
    manifestId: id.manifestId,
    createdAt: id.createdAt,
    stateVersion: id.stateVersion,
    query: { kind: 'conjunction', entityIds: [result.a, result.b] },
    emphasis: {
      anchors: emphasisMap(anchors),
      islands: new Map(result.islands.map((i) => [i, 'secondary' as EmphasisLevel])),
      defaultLevel: 'muted',
    },
    threads: Object.freeze(threads),
    captions: Object.freeze([]),
    focusCandidates: Object.freeze(result.bothPresent.map(([x]) => x)),
    summary: {
      key: 'summary.conjunction',
      counts: Object.freeze([
        { key: 'count.both', value: result.bothPresent.length, swapTo: [result.a, result.b] },
        { key: 'count.aOnly', value: result.aOnly.length, swapTo: [result.a] },
        { key: 'count.bOnly', value: result.bOnly.length, swapTo: [result.b] },
      ]),
      evidence: result.evidence,
    },
    transition: transition(id.reducedMotion),
  };
  return Object.freeze(manifest);
}

// ---------------------------------------------------------------------------------------------
// The preview slot: a tier 2 blast radius, rendered in the real world before commit.
// ---------------------------------------------------------------------------------------------

export interface ProposalPreview {
  readonly entityIds: readonly EntityId[];
  /** Anchors that WOULD join if the proposal were committed. */
  readonly affected: readonly AnchorId[];
  /** Threads that WOULD be drawn. Rendered as candidates: dashed, and visibly unconfirmed. */
  readonly wouldLink: readonly (readonly [AnchorId, AnchorId])[];
  readonly islands: readonly IslandId[];
}

/**
 * interaction-model.md 5.3, tier 2: "A live preview in the Atlas behind the panel. The proposal
 * generates a view manifest assigned to the preview slot, so the anchors that would join are
 * highlighted and threaded BEFORE commit, in the actual world. Cancel restores instantly because
 * nothing was mutated."
 *
 * This is the same code path as a query, which is exactly why it costs nothing extra.
 */
export function buildPreviewManifest(
  id: ManifestIdentity,
  preview: ProposalPreview,
): ViewManifest {
  const anchors = preview.affected.map((a) => [a, 'primary'] as const);
  const threads = preview.wouldLink.map(([x, y]) =>
    thread(x, y, preview.entityIds[0] ?? ('' as EntityId), 'candidate', 0.7, 0),
  );

  const manifest: ViewManifest = {
    manifestId: id.manifestId,
    createdAt: id.createdAt,
    stateVersion: id.stateVersion,
    query: { kind: 'preview', entityIds: preview.entityIds },
    emphasis: {
      anchors: emphasisMap(anchors),
      islands: new Map(preview.islands.map((i) => [i, 'secondary' as EmphasisLevel])),
      defaultLevel: 'muted',
    },
    threads: Object.freeze(threads),
    captions: Object.freeze([]),
    focusCandidates: Object.freeze([...preview.affected]),
    summary: {
      key: 'summary.blastRadius',
      counts: Object.freeze([
        { key: 'count.anchors', value: preview.affected.length, swapTo: null },
        { key: 'count.regions', value: preview.islands.length, swapTo: null },
      ]),
      evidence: Object.freeze([]),
    },
    transition: transition(id.reducedMotion),
  };
  return Object.freeze(manifest);
}

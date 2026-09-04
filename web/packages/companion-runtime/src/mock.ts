import type {
  AssertionView,
  EntityRecord,
  GraphSnapshot,
  IslandRecord,
  MatchProposalView,
  OccurrenceRecord,
} from '@exulanica/graph-client';

/**
 * REALISTIC FIXTURE DATA, shaped like the real domain types.
 *
 * Two captures, which is the actual corpus shape: "most users upload 1 or 2 photos, so the
 * single-photo path is the primary experience". A kitchen photograph from 2019 with three faces,
 * and a harbour photograph from 2021 whose faces are not yet promoted to entities.
 *
 * The three snapshots below reproduce, exactly, the worked example in interaction-model.md 4.4:
 *
 *   T1  unnamed person, three occurrences        -> resolve identity
 *   T2  named, and a candidate link to the harbour -> confirm continuity
 *   T3  now spanning two regions, name unscoped  -> "use that as her display name everywhere?"
 *
 * Each turn's options are reachable only because the previous answer changed the graph. That is
 * the property under test, and it is the reason the fixture is three snapshots rather than one.
 *
 * This module is fixtures, not runtime state. It is exported because world-index renders the
 * same data and the two surfaces must be demonstrably looking at one shape.
 */

const KITCHEN = 'isl-kitchen-2019';
const HARBOUR = 'isl-harbour-2021';

export const MOCK_ISLANDS = Object.freeze({ kitchen: KITCHEN, harbour: HARBOUR });

const captureAssertion = (
  id: string,
  predicateKey: string,
  value: unknown,
  evidence: readonly string[],
  mediaKey: string,
): AssertionView =>
  Object.freeze({
    assertionId: id,
    kind: 'capture' as const,
    predicateKey,
    status: 'active' as const,
    objectValue: value,
    supportEvidence: Object.freeze([...evidence]),
    producedBy: Object.freeze({ by: 'capture' as const, mediaKey }),
    // A capture assertion has no confidence. It has support. epi-1 keeps those apart.
    confidence: null,
    assertedAtMs: Date.UTC(2026, 7, 20),
    supersedes: null,
  });

const inferenceAssertion = (
  id: string,
  predicateKey: string,
  value: unknown,
  evidence: readonly string[],
  confidence: 'low' | 'medium' | 'high',
): AssertionView =>
  Object.freeze({
    assertionId: id,
    kind: 'inference' as const,
    predicateKey,
    status: 'active' as const,
    objectValue: value,
    supportEvidence: Object.freeze([...evidence]),
    producedBy: Object.freeze({
      by: 'pipeline' as const,
      runId: 'run-2026-08-20-perception',
      modelRef: 'vision-sensor-v3',
    }),
    confidence,
    assertedAtMs: Date.UTC(2026, 7, 20),
    supersedes: null,
  });

const userAssertion = (
  id: string,
  predicateKey: string,
  value: unknown,
  atMs: number,
): AssertionView =>
  Object.freeze({
    assertionId: id,
    kind: 'user' as const,
    predicateKey,
    status: 'active' as const,
    objectValue: value,
    supportEvidence: Object.freeze([]),
    producedBy: Object.freeze({ by: 'user' as const, statedAtMs: atMs }),
    confidence: null,
    assertedAtMs: atMs,
    supersedes: null,
  });

const NOW = Date.UTC(2026, 7, 27, 10, 0, 0);

// ---------------------------------------------------------------------------------------------
// Occurrences. Anonymous by construction: nothing here carries a name.
// ---------------------------------------------------------------------------------------------

const occurrence = (
  key: string,
  islandId: string,
  entityId: string | null,
  linkState: OccurrenceRecord['linkState'],
  confidence: OccurrenceRecord['confidence'],
  capturedAtMs: number | null,
  kind: OccurrenceRecord['kind'] = 'person',
): OccurrenceRecord =>
  Object.freeze({
    occurrenceId: `occ-${key}`,
    anchorId: `anc-${key}`,
    islandId,
    kind,
    entityId,
    linkState,
    confidence,
    evidence: Object.freeze([`span-${key}`]),
    capturedAtMs,
  });

const KITCHEN_AT = Date.UTC(2019, 10, 3, 19, 12);
const HARBOUR_AT = Date.UTC(2021, 5, 18, 8, 40);

const OCCURRENCES: readonly OccurrenceRecord[] = Object.freeze([
  occurrence('kitchen-face-a', KITCHEN, 'ent-julie', 'auto_provisional', 'medium', KITCHEN_AT),
  occurrence('kitchen-face-b', KITCHEN, 'ent-julie', 'auto_provisional', 'medium', KITCHEN_AT),
  occurrence('kitchen-face-c', KITCHEN, 'ent-julie', 'auto_provisional', 'low', KITCHEN_AT),
  occurrence('kitchen-face-d', KITCHEN, 'ent-mira', 'confirmed', 'high', KITCHEN_AT),
  occurrence('kitchen-bike', KITCHEN, 'ent-bike', 'confirmed', 'high', KITCHEN_AT),
  // Harbour faces are detected but NOT promoted to an entity. id-1: an occurrence is anonymous,
  // and nothing has yet decided who these are. This is the normal state, not a gap.
  occurrence('harbour-face-a', HARBOUR, null, 'proposed', 'medium', HARBOUR_AT),
  occurrence('harbour-face-b', HARBOUR, null, 'proposed', 'low', HARBOUR_AT),
  occurrence('harbour-place', HARBOUR, 'ent-harbour', 'confirmed', 'high', HARBOUR_AT),
  occurrence('harbour-bike', HARBOUR, 'ent-bike', 'auto_provisional', 'medium', HARBOUR_AT),
]);

// ---------------------------------------------------------------------------------------------
// Entities.
// ---------------------------------------------------------------------------------------------

/** The subject of the worked example, before she has a name. */
const JULIE_T1: EntityRecord = Object.freeze({
  entityId: 'ent-julie',
  kind: 'person',
  displayName: null,
  status: 'needs_review',
  occurrenceCount: 3,
  islandIds: Object.freeze([KITCHEN]),
  firstSeenMs: KITCHEN_AT,
  lastSeenMs: KITCHEN_AT,
  confidence: 'medium',
  openQuestionCount: 2,
  citingAnswerCount: 3,
  assertions: Object.freeze([
    captureAssertion(
      'asr-julie-captured-at',
      'captured_at_is',
      { iso: '2019-11-03T19:12:00Z', uncertaintyMs: 60_000 },
      ['span-kitchen-face-a'],
      'blob-kitchen',
    ),
    inferenceAssertion(
      'asr-julie-present',
      'person_present',
      { class: 'person' },
      ['span-kitchen-face-a', 'span-kitchen-face-b', 'span-kitchen-face-c'],
      'medium',
    ),
  ]),
  relations: Object.freeze([]),
  contradictions: Object.freeze([]),
  history: Object.freeze([
    {
      eventId: 'evt-julie-created',
      type: 'entity_created' as const,
      actor: 'system' as const,
      atMs: Date.UTC(2026, 7, 20),
      stateVersion: 1,
      rawUtterance: null,
      summaryKey: 'history.entityCreatedFromDetections',
      undoes: null,
    },
  ]),
  mergedInto: null,
});

/** A named person with no stated relationship. Drives the multi-select attribute pool. */
const MIRA: EntityRecord = Object.freeze({
  entityId: 'ent-mira',
  kind: 'person',
  displayName: 'Mira',
  status: 'confirmed',
  occurrenceCount: 1,
  islandIds: Object.freeze([KITCHEN]),
  firstSeenMs: KITCHEN_AT,
  lastSeenMs: KITCHEN_AT,
  confidence: null,
  openQuestionCount: 1,
  citingAnswerCount: 0,
  assertions: Object.freeze([
    userAssertion('asr-mira-name', 'name_is', { displayName: 'Mira' }, Date.UTC(2026, 7, 21)),
  ]),
  relations: Object.freeze([]),
  contradictions: Object.freeze([]),
  history: Object.freeze([]),
  mergedInto: null,
});

/** A public place, carrying the one `external` assertion in the fixture. */
const HARBOUR_PLACE: EntityRecord = Object.freeze({
  entityId: 'ent-harbour',
  kind: 'place',
  displayName: 'Old Harbour',
  status: 'confirmed',
  occurrenceCount: 1,
  islandIds: Object.freeze([HARBOUR]),
  firstSeenMs: HARBOUR_AT,
  lastSeenMs: HARBOUR_AT,
  confidence: null,
  openQuestionCount: 0,
  citingAnswerCount: 5,
  assertions: Object.freeze([
    userAssertion(
      'asr-harbour-name',
      'name_is',
      { displayName: 'Old Harbour' },
      Date.UTC(2026, 7, 22),
    ),
    Object.freeze({
      assertionId: 'asr-harbour-external',
      kind: 'external' as const,
      predicateKey: 'public_description_is',
      status: 'active' as const,
      objectValue: { summary: 'Working harbour, rebuilt 1974.' },
      supportEvidence: Object.freeze([]),
      producedBy: Object.freeze({
        by: 'external' as const,
        url: 'https://example.org/old-harbour',
        retrievedAtMs: Date.UTC(2026, 7, 26),
        snapshotHash: 'sha256:6f1c…',
      }),
      confidence: null,
      assertedAtMs: Date.UTC(2026, 7, 26),
      supersedes: null,
    }),
  ]),
  relations: Object.freeze([]),
  contradictions: Object.freeze([]),
  history: Object.freeze([]),
  mergedInto: null,
});

/** An object whose model reading contradicts what the user said. Never applied, always asked. */
const BIKE: EntityRecord = Object.freeze({
  entityId: 'ent-bike',
  kind: 'object',
  displayName: "Dad's bicycle",
  status: 'needs_review',
  occurrenceCount: 2,
  islandIds: Object.freeze([KITCHEN, HARBOUR]),
  firstSeenMs: KITCHEN_AT,
  lastSeenMs: HARBOUR_AT,
  confidence: 'low',
  openQuestionCount: 1,
  citingAnswerCount: 1,
  assertions: Object.freeze([
    userAssertion(
      'asr-bike-name',
      'name_is',
      { displayName: "Dad's bicycle" },
      Date.UTC(2026, 7, 23),
    ),
    userAssertion(
      'asr-bike-scope',
      'name_scope_is',
      { scope: 'everywhere' },
      Date.UTC(2026, 7, 23),
    ),
    userAssertion('asr-bike-relation', 'relation_is', { value: 'family' }, Date.UTC(2026, 7, 23)),
    inferenceAssertion(
      'asr-bike-colour',
      'colour_is',
      { value: 'green' },
      ['span-harbour-bike'],
      'low',
    ),
  ]),
  relations: Object.freeze([
    {
      predicateKey: 'belongs_to',
      objectEntityId: 'ent-mira',
      kind: 'user' as const,
      supportEvidence: Object.freeze([]),
    },
  ]),
  contradictions: Object.freeze([
    {
      contradictionId: 'con-bike-colour',
      userAssertionId: 'asr-bike-name',
      otherAssertionId: 'asr-bike-colour',
      predicateKey: 'colour_is',
      openedAtMs: Date.UTC(2026, 7, 24),
    },
  ]),
  history: Object.freeze([]),
  mergedInto: null,
});

/** Deleted. Present so the "never offer an option targeting a deleted entity" rule has a target. */
const GHOST: EntityRecord = Object.freeze({
  ...MIRA,
  entityId: 'ent-ghost',
  displayName: null,
  status: 'rejected',
  openQuestionCount: 0,
  assertions: Object.freeze([]),
});

// ---------------------------------------------------------------------------------------------
// Match proposals.
// ---------------------------------------------------------------------------------------------

/**
 * The harbour candidate: "the same person as in these other captures", never a real-world
 * identity (id-6). `candidateEntityId` is null because the harbour faces are still anonymous
 * occurrences, which is exactly why this reads as a continuity question and not a merge.
 */
const HARBOUR_MATCH: MatchProposalView = Object.freeze({
  matchId: 'match-julie-harbour',
  entityId: 'ent-julie',
  candidateEntityId: null,
  occurrenceIds: Object.freeze(['occ-harbour-face-a']),
  anchorIds: Object.freeze(['anc-harbour-face-a']),
  islandIds: Object.freeze([HARBOUR]),
  confidence: 'medium',
  basisModalities: Object.freeze(['face', 'context_cooccurrence']),
  suppressedByRejection: false,
  newModality: null,
  evidence: Object.freeze(['span-harbour-face-a']),
});

/** A candidate the user already rejected on the same basis. id-4: never re-proposed identically. */
const SUPPRESSED_MATCH: MatchProposalView = Object.freeze({
  matchId: 'match-mira-harbour',
  entityId: 'ent-mira',
  candidateEntityId: null,
  occurrenceIds: Object.freeze(['occ-harbour-face-b']),
  anchorIds: Object.freeze(['anc-harbour-face-b']),
  islandIds: Object.freeze([HARBOUR]),
  confidence: 'low',
  basisModalities: Object.freeze(['face']),
  suppressedByRejection: true,
  newModality: null,
  evidence: Object.freeze(['span-harbour-face-b']),
});

/** A candidate across a pair a previous split already asserted distinct (`never_same`). */
const DISTINCT_MATCH: MatchProposalView = Object.freeze({
  matchId: 'match-mira-julie',
  entityId: 'ent-mira',
  candidateEntityId: 'ent-julie',
  occurrenceIds: Object.freeze(['occ-kitchen-face-a']),
  anchorIds: Object.freeze(['anc-kitchen-face-a']),
  islandIds: Object.freeze([KITCHEN]),
  confidence: 'high',
  basisModalities: Object.freeze(['face', 'context_place']),
  suppressedByRejection: false,
  newModality: null,
  evidence: Object.freeze(['span-kitchen-face-a']),
});

/** A candidate pointing at an entity the user deleted. Dropped entirely, never greyed out. */
const GHOST_MATCH: MatchProposalView = Object.freeze({
  matchId: 'match-mira-ghost',
  entityId: 'ent-mira',
  candidateEntityId: 'ent-ghost',
  occurrenceIds: Object.freeze(['occ-harbour-face-b']),
  anchorIds: Object.freeze(['anc-harbour-face-b']),
  islandIds: Object.freeze([HARBOUR]),
  confidence: 'high',
  basisModalities: Object.freeze(['face']),
  suppressedByRejection: false,
  newModality: null,
  evidence: Object.freeze(['span-harbour-face-b']),
});

/** Exported so a test can compose the exact pruning situation it is about. */
export const MOCK_MATCHES = Object.freeze({
  julieHarbour: HARBOUR_MATCH,
  miraSuppressed: SUPPRESSED_MATCH,
  miraAssertedDistinct: DISTINCT_MATCH,
  miraDeleted: GHOST_MATCH,
});

// ---------------------------------------------------------------------------------------------
// The three snapshots.
// ---------------------------------------------------------------------------------------------

const base = (
  stateVersion: number,
  julie: EntityRecord,
  matchProposals: readonly MatchProposalView[],
  occurrences: readonly OccurrenceRecord[],
): GraphSnapshot =>
  Object.freeze({
    stateVersion,
    entities: Object.freeze([julie, MIRA, HARBOUR_PLACE, BIKE, GHOST]),
    occurrences,
    // Derived from the occurrences rather than written out, so the fixture cannot describe an
    // island that none of its anchors sit in, or omit one that they do.
    islands: islandsOf(occurrences),
    matchProposals,
    // Written by a previous split. The pool refuses to offer a merge across it, with a reason.
    neverSame: Object.freeze([Object.freeze(['ent-mira', 'ent-julie'] as const)]),
    deletedEntityIds: Object.freeze(['ent-ghost']),
  });

/**
 * The islands these occurrences imply, exactly.
 *
 * The fixture predates islands being on the snapshot, and hand-writing them would create a
 * second place the fixture states which regions exist. One capture per island here, which is
 * what this two-photograph fixture is: `positionedCaptureCount` is zero because neither
 * photograph in it carries a fix, and a spread of null says so rather than claiming a radius.
 */
function islandsOf(occurrences: readonly OccurrenceRecord[]): readonly IslandRecord[] {
  const byIsland = new Map<string, { first: number | null; last: number | null }>();
  for (const occurrence of occurrences) {
    const seen = byIsland.get(occurrence.islandId) ?? { first: null, last: null };
    const at = occurrence.capturedAtMs;
    byIsland.set(occurrence.islandId, {
      first: at === null ? seen.first : Math.min(seen.first ?? at, at),
      last: at === null ? seen.last : Math.max(seen.last ?? at, at),
    });
  }
  return Object.freeze(
    [...byIsland.entries()].map(([islandId, times]) =>
      Object.freeze({
        islandId,
        captureIds: Object.freeze([islandId]),
        firstCapturedAtMs: times.first,
        lastCapturedAtMs: times.last,
        positionedCaptureCount: 0,
        spreadMetres: null,
        // Nothing has reconstructed this fixture, which is a different fact from rung 4 and
        // is carried as one: rung 4 means reconstruction ran and found nothing to place.
        rung: null,
        rungCaptureCount: 0,
      }),
    ),
  );
}

/** T1: an unnamed person with three occurrences and no candidate link yet. */
export const SNAPSHOT_T1: GraphSnapshot = base(11, JULIE_T1, [SUPPRESSED_MATCH], OCCURRENCES);

/**
 * T2: the user has named her and stated a relationship, and the pipeline has since produced a
 * candidate link to the harbour capture. Neither question was askable at T1.
 */
export const JULIE_T2: EntityRecord = Object.freeze({
  ...JULIE_T1,
  displayName: 'Julie',
  status: 'user_asserted',
  openQuestionCount: 1,
  assertions: Object.freeze([
    ...JULIE_T1.assertions,
    userAssertion('asr-julie-name', 'name_is', { displayName: 'Julie' }, NOW),
    userAssertion('asr-julie-relation', 'relation_is', { value: 'friend' }, NOW),
    userAssertion('asr-julie-note', 'note', { text: 'a close friend I met in college' }, NOW),
  ]),
  relations: Object.freeze([
    {
      predicateKey: 'relation_is',
      objectEntityId: 'ent-julie',
      kind: 'user' as const,
      supportEvidence: Object.freeze([]),
    },
  ]),
});

export const SNAPSHOT_T2: GraphSnapshot = base(
  12,
  JULIE_T2,
  [HARBOUR_MATCH, SUPPRESSED_MATCH],
  OCCURRENCES,
);

/**
 * T3: the continuity was confirmed, so she now spans two regions and her name has no scope yet.
 * "She now links four captures across two regions. Use that as her display name everywhere?"
 */
export const JULIE_T3: EntityRecord = Object.freeze({
  ...JULIE_T2,
  status: 'confirmed',
  occurrenceCount: 4,
  islandIds: Object.freeze([KITCHEN, HARBOUR]),
  lastSeenMs: HARBOUR_AT,
});

const OCCURRENCES_T3: readonly OccurrenceRecord[] = Object.freeze(
  OCCURRENCES.map((o) =>
    o.occurrenceId === 'occ-harbour-face-a'
      ? Object.freeze({ ...o, entityId: 'ent-julie', linkState: 'confirmed' as const })
      : o,
  ),
);

export const SNAPSHOT_T3: GraphSnapshot = base(13, JULIE_T3, [SUPPRESSED_MATCH], OCCURRENCES_T3);

export const MOCK_NOW_MS = NOW;

/** Swap the candidate links on a snapshot, leaving everything else identical. */
export function withMatchProposals(
  snapshot: GraphSnapshot,
  matchProposals: readonly MatchProposalView[],
): GraphSnapshot {
  return Object.freeze({ ...snapshot, matchProposals: Object.freeze([...matchProposals]) });
}

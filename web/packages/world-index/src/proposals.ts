import type { EntityRecord, GraphSnapshot } from '@exulanica/graph-client';
import { occurrencesOf } from '@exulanica/graph-client';
import type { ConfirmationSummary, IdFactory, ProposalDraft } from '@exulanica/companion-runtime';
import { buildConfirmation, draftOperation, makeDraft, tierPolicy } from '@exulanica/companion-runtime';
import { ACTION_TIER } from './actions.js';

/**
 * INDEX ACTIONS THAT WRITE (interaction-model.md 6.1, 5.1, 5.3).
 *
 * Edit, Merge, Split and Delete all end in a proposal, because 5.1 admits no exception: "no
 * free-text answer and no choice ever mutates the graph directly ... only an explicit
 * confirmation commits it". The index is not a privileged surface. It differs from the dialogue
 * panel in exactly one respect, which 5.3 spells out: it is the only place Delete exists.
 *
 * These builders use companion-runtime's `draftOperation`, so the tier is derived from what the
 * operation touches and the confirmation obligations come from the one policy table. A merge
 * confirmed here shows the same blast radius, the same live preview and the same two controls as
 * a merge confirmed in the dialogue panel.
 */

function footprint(snapshot: GraphSnapshot, entity: EntityRecord): {
  anchorIds: readonly string[];
  islandIds: readonly string[];
} {
  const anchorIds: string[] = [];
  const islands = new Set<string>();
  for (const o of occurrencesOf(snapshot, entity.entityId)) {
    anchorIds.push(o.anchorId);
    islands.add(o.islandId);
  }
  return { anchorIds, islandIds: [...islands] };
}

/** Edit: rename, or amend a user statement. Tier 1, unless it reaches far enough to be tier 2. */
export function draftEdit(
  snapshot: GraphSnapshot,
  entity: EntityRecord,
  displayName: string,
  ids: IdFactory,
): ProposalDraft {
  const foot = footprint(snapshot, entity);
  return makeDraft({
    draftId: ids('draft'),
    origin: 'user_utterance',
    rawUtterance: displayName,
    subjectEntityId: entity.entityId,
    operations: [
      draftOperation('name', foot.anchorIds, foot.islandIds, {
        predicateKey: 'name_is',
        displayName,
      }),
    ],
    provenanceSummaryKey: 'provenance.userEditedName',
  });
}

/**
 * Merge (A, B -> C). Always tier 2.
 *
 * id-7: merge is an EVENT, not a mutation. "A and B survive as alias redirects so old permalinks
 * and old answers still resolve. The payload records the exact link set at merge time, which is
 * what makes undo exact rather than approximate." That exact link set is why the payload carries
 * every occurrence id rather than just the two entity ids.
 */
export function draftMerge(
  snapshot: GraphSnapshot,
  survivor: EntityRecord,
  absorbed: readonly EntityRecord[],
  ids: IdFactory,
): ProposalDraft {
  if (absorbed.length < 1) throw new RangeError('a merge needs at least two entities');
  if (absorbed.some((entity) => entity.entityId === survivor.entityId)) {
    throw new RangeError('a record cannot be merged into itself');
  }
  // THE SURVIVOR IS A PARAMETER, and it is the whole reason this function changed shape. It used
  // to emit a flat list and leave which record survives to be inferred downstream, which nothing
  // could do: the two records are symmetric in the payload and only the user knows which name
  // should remain. A merge that went the wrong way round is undoable only if somebody notices,
  // so the answer is carried rather than guessed.
  if (survivor.displayName === null && absorbed.some((e) => e.displayName !== null)) {
    throw new RangeError(
      'merging a named record into an unnamed one would leave the surviving record unnamed. ' +
        'Merge the other way round.',
    );
  }
  const from = [survivor, ...absorbed];
  const anchorIds = new Set<string>();
  const islandIds = new Set<string>();
  const occurrenceIds: string[] = [];
  for (const entity of from) {
    for (const o of occurrencesOf(snapshot, entity.entityId)) {
      anchorIds.add(o.anchorId);
      islandIds.add(o.islandId);
      occurrenceIds.push(o.occurrenceId);
    }
  }
  return makeDraft({
    draftId: ids('draft'),
    origin: 'user_choice',
    rawUtterance: '',
    subjectEntityId: survivor.entityId,
    operations: [
      draftOperation('merge', [...anchorIds], [...islandIds], {
        // The endpoint's own vocabulary, so nothing downstream renames a key and decides a
        // semantic question by doing it. `occurrenceIds` stays because id-7 says the payload
        // records the exact link set at merge time, "which is what makes undo exact rather than
        // approximate", and the endpoint's two fields cannot carry that.
        target: survivor.entityId,
        sources: absorbed.map((entity) => entity.entityId),
        occurrenceIds,
        // The NAMES, so a confirmation surface can say what will happen in words rather than in
        // identifiers. `subjectEntityId` carries the survivor's id and cannot carry this.
        survivorName: survivor.displayName,
        absorbedNames: absorbed.map((entity) => entity.displayName),
      }),
    ],
    provenanceSummaryKey: 'provenance.userMergedEntities',
  });
}

/**
 * Split (C -> A', B'). Always tier 2.
 *
 * The payload carries "the explicit partition of C's occurrence links, CHOSEN BY THE USER" (3.4),
 * and the split writes a `never_same` constraint, which is what stops the pipeline proposing the
 * merge straight back on the next run.
 */
export function draftSplit(
  entity: EntityRecord,
  partition: readonly (readonly string[])[],
  ids: IdFactory,
  anchorIdsByOccurrence: ReadonlyMap<string, string> = new Map(),
): ProposalDraft {
  if (partition.length < 2) throw new RangeError('a split needs at least two groups');
  const anchorIds = partition
    .flat()
    .map((o) => anchorIdsByOccurrence.get(o))
    .filter((a): a is string => a !== undefined);

  return makeDraft({
    draftId: ids('draft'),
    origin: 'user_choice',
    rawUtterance: '',
    subjectEntityId: entity.entityId,
    operations: [
      draftOperation('split', anchorIds, entity.islandIds, {
        partition: partition.map((group) => [...group]),
        writesNeverSame: true,
      }),
    ],
    provenanceSummaryKey: 'provenance.userSplitEntity',
  });
}

/**
 * What a delete would cost, stated before it happens.
 *
 * 5.3 tier 3 requires all three of these, and requires the retention statement "rendered EVERY
 * SINGLE TIME": "Deleting an entity removes the INDEX OVER the media, not the media. The
 * retention guarantee is restated at the exact moment the user is most likely to doubt it."
 */
export interface DeleteConsequences {
  readonly typedConfirmationOf: string | null;
  readonly mediaRetentionStatementKey: 'delete.originalMediaIsNotDeleted';
  readonly citingAnswerCount: number;
  readonly occurrenceCount: number;
  readonly islandCount: number;
  /** Tier 3 is out of the MVP cut. The rule stands regardless (5.3). */
  readonly availableInMvp: boolean;
}

export function deleteConsequences(entity: EntityRecord): DeleteConsequences {
  return Object.freeze({
    // Null when the entity has no name: there is nothing to type, and the surface must fall back
    // to a different tier 3 challenge rather than silently accepting an empty string.
    typedConfirmationOf: entity.displayName,
    mediaRetentionStatementKey: 'delete.originalMediaIsNotDeleted',
    citingAnswerCount: entity.citingAnswerCount,
    occurrenceCount: entity.occurrenceCount,
    islandCount: entity.islandIds.length,
    availableInMvp: tierPolicy(ACTION_TIER.delete).inMvp,
  });
}

export function draftDelete(
  snapshot: GraphSnapshot,
  entity: EntityRecord,
  ids: IdFactory,
): ProposalDraft {
  const foot = footprint(snapshot, entity);
  return makeDraft({
    draftId: ids('draft'),
    origin: 'user_choice',
    rawUtterance: '',
    subjectEntityId: entity.entityId,
    operations: [
      draftOperation('delete', foot.anchorIds, foot.islandIds, {
        entityId: entity.entityId,
        // Stated in the payload as well as in the copy, so an audit of the operation shows it.
        removesIndexNotMedia: true,
      }),
    ],
    provenanceSummaryKey: 'provenance.userDeletedEntity',
  });
}

/**
 * The confirmation for any index-originated draft.
 *
 * Always `world_index`, which is what makes a tier 3 proposal legal here and illegal in the
 * dialogue panel. The bands themselves are the same four bands either way.
 */
export function confirmationFor(
  draft: ProposalDraft,
  entity: EntityRecord,
  anchorForEvidence?: ReadonlyMap<string, string>,
): ConfirmationSummary {
  return buildConfirmation({
    draft,
    entity,
    surface: 'world_index',
    ...(anchorForEvidence === undefined ? {} : { anchorForEvidence }),
  });
}

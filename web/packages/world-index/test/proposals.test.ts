import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@exulanica/graph-client';
import { ProposalGate, ProposalGateError } from '@exulanica/graph-client/mutations';
import {
  SNAPSHOT_T3,
  finalizeDraft,
  sequentialIds,
  unmetRequirements,
} from '@exulanica/companion-runtime';
import type { ConfirmationAcknowledgement } from '@exulanica/companion-runtime';
import {
  confirmationFor,
  deleteConsequences,
  draftDelete,
  draftEdit,
  draftMerge,
  draftSplit,
} from '../src/index.js';

const entity = (id: string): EntityRecord => {
  const found = SNAPSHOT_T3.entities.find((e) => e.entityId === id);
  if (found === undefined) throw new Error(`fixture lost ${id}`);
  return found;
};

const ack = (o: Partial<ConfirmationAcknowledgement> = {}): ConfirmationAcknowledgement => ({
  surface: 'world_index',
  openForMs: 5_000,
  blastRadiusShown: true,
  livePreviewShown: true,
  typedDisplayName: null,
  mediaRetentionStatementShown: true,
  citationLossCountShown: true,
  ...o,
});

describe('index actions end in a proposal, like every other path', () => {
  it('makes a merge tier 2 with a blast radius that names the regions', () => {
    const draft = draftMerge(
      SNAPSHOT_T3,
      entity('ent-julie'),
      [entity('ent-mira')],
      sequentialIds(),
    );
    expect(draft.maxTier).toBe(2);

    const confirmation = confirmationFor(draft, entity('ent-julie'));
    expect(confirmation.blastRadius?.islandCount).toBe(2);
    expect(confirmation.blastRadius?.anchorCount).toBe(5);
    expect(confirmation.policy.requiresLivePreview).toBe(true);
    // id-7: merge is an event, so it is reversible and the copy may say so.
    expect(confirmation.reversible).toBe(true);
  });

  it('records the exact link set, which is what makes undo exact', () => {
    const draft = draftMerge(
      SNAPSHOT_T3,
      entity('ent-julie'),
      [entity('ent-mira')],
      sequentialIds(),
    );
    const payload = draft.operations[0]?.payload as {
      occurrenceIds?: readonly string[];
      target?: string;
      sources?: readonly string[];
    };
    expect(payload.occurrenceIds?.length).toBe(5);
    // The endpoint's own vocabulary, so nothing downstream has to rename a key and decide a
    // semantic question by doing it.
    expect(payload.target).toBe('ent-julie');
    expect(payload.sources).toEqual(['ent-mira']);
  });

  it('refuses to merge a named record into an unnamed one', () => {
    // The surviving record keeps its name, so merging a named record into an unnamed one would
    // leave the survivor unnamed and the name only readable in history. A user who wanted that
    // wanted the merge the other way round.
    expect(() =>
      draftMerge(
        SNAPSHOT_T3,
        { ...entity('ent-mira'), displayName: null },
        [entity('ent-julie')],
        sequentialIds(),
      ),
    ).toThrow(/the other way round/);
  });

  it('refuses to merge a record into itself', () => {
    expect(() =>
      draftMerge(SNAPSHOT_T3, entity('ent-julie'), [entity('ent-julie')], sequentialIds()),
    ).toThrow(/into itself/);
  });

  it('makes a split tier 2 and says it writes a never-same constraint', () => {
    const draft = draftSplit(
      entity('ent-julie'),
      [['occ-kitchen-face-a', 'occ-kitchen-face-b'], ['occ-harbour-face-a']],
      sequentialIds(),
    );
    expect(draft.maxTier).toBe(2);
    expect(draft.operations[0]?.payload['writesNeverSame']).toBe(true);
  });

  it('escalates a rename to tier 2 once the entity spans two regions', () => {
    const acrossTwo = draftEdit(SNAPSHOT_T3, entity('ent-julie'), 'Julie R.', sequentialIds());
    expect(acrossTwo.maxTier).toBe(2);
    const withinOne = draftEdit(SNAPSHOT_T3, entity('ent-mira'), 'Mira K.', sequentialIds());
    expect(withinOne.maxTier).toBe(1);
  });
});

describe('delete is tier 3, and every tier 3 obligation is checkable', () => {
  const julie = () => entity('ent-julie');

  it('states the retention guarantee, the citation loss and the typed challenge', () => {
    const consequences = deleteConsequences(julie());
    expect(consequences.mediaRetentionStatementKey).toBe('delete.originalMediaIsNotDeleted');
    expect(consequences.citingAnswerCount).toBe(3);
    expect(consequences.typedConfirmationOf).toBe('Julie');
    expect(consequences.availableInMvp).toBe(false);
  });

  it('refuses when the typed name does not match, or the retention line was not shown', () => {
    const draft = draftDelete(SNAPSHOT_T3, julie(), sequentialIds());
    expect(draft.maxTier).toBe(3);
    expect(draft.reversible).toBe(false);

    expect(unmetRequirements(3, ack({ typedDisplayName: 'julie' }), 'Julie')).toContain(
      'typedName.mismatch',
    );
    expect(
      unmetRequirements(
        3,
        ack({ typedDisplayName: 'Julie', mediaRetentionStatementShown: false }),
        'Julie',
      ),
    ).toContain('mediaRetention.notStated');
    expect(
      unmetRequirements(3, ack({ typedDisplayName: 'Julie', citationLossCountShown: false }), 'Julie'),
    ).toContain('citationLoss.notStated');
  });

  it('is refused by the gate regardless, because tier 3 is out of the MVP cut', async () => {
    const draft = draftDelete(SNAPSHOT_T3, julie(), sequentialIds());
    const proposal = finalizeDraft(draft, 'proposal-delete', 'turn-index', 13);
    const gate = new ProposalGate(async () => 14, 13);
    gate.stage(proposal);
    await expect(gate.commit('proposal-delete')).rejects.toBeInstanceOf(ProposalGateError);
  });

  it('is refused outright from the dialogue surface', () => {
    const draft = draftDelete(SNAPSHOT_T3, julie(), sequentialIds());
    expect(unmetRequirements(draft.maxTier, ack({ surface: 'dialogue' }), 'Julie')).toContain(
      'surface.notPermitted',
    );
  });
});

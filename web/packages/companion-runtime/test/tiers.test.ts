import { describe, expect, it } from 'vitest';
import { ProposalGateError } from '@exulanica/graph-client/mutations';
import { deriveTier } from '@exulanica/graph-client';
import {
  CompanionSession,
  ConfirmationRefusedError,
  MOCK_NOW_MS,
  SNAPSHOT_T2,
  SNAPSHOT_T3,
  TierPolicyError,
  assertBatchable,
  assertMultiSelectable,
  assertOfferable,
  draftOperation,
  finalizeDraft,
  makeDraft,
  sequentialIds,
  tierPolicy,
  unmetRequirements,
  validateTurn,
} from '../src/index.js';
import type { Turn } from '../src/index.js';
import { fullAck, recordingGate } from './harness.js';

describe('the tier is derived from what an operation touches, never declared', () => {
  it('escalates a rename to tier 2 the moment it spans two regions', () => {
    expect(deriveTier('name', 1, 1)).toBe(1);
    expect(deriveTier('name', 1, 2)).toBe(2);
    expect(deriveTier('name', 7, 1)).toBe(2);
    expect(deriveTier('merge', 0, 0)).toBe(2);
    expect(deriveTier('delete', 0, 0)).toBe(3);
  });

  it('gives the same answer through the draft builder, which has no tier parameter', () => {
    const op = draftOperation('name', ['a1', 'a2'], ['i1', 'i2'], { displayName: 'Julie' });
    expect(op.tier).toBe(2);
  });
});

describe('tier 2 cannot be confirmed without its blast radius and its live preview', () => {
  const stageTier2 = () => {
    const { gate, committed } = recordingGate(SNAPSHOT_T3.stateVersion);
    const s = new CompanionSession({ snapshot: SNAPSHOT_T3, gate, ids: sequentialIds() });
    s.advance(MOCK_NOW_MS, 'ent-julie');
    // Julie now spans two regions, so setting her display name everywhere is tier 2.
    const outcome = s.select('enrich_relation:useEverywhere', MOCK_NOW_MS);
    if (outcome.kind !== 'awaiting_confirmation') throw new Error('expected a proposal');
    return { session: s, committed, outcome };
  };

  it('states the blast radius in counts, and names the regions', () => {
    const { outcome } = stageTier2();
    expect(outcome.proposal.maxTier).toBe(2);
    expect(outcome.confirmation.blastRadius).not.toBeNull();
    expect(outcome.confirmation.blastRadius?.islandCount).toBe(2);
    expect(outcome.confirmation.blastRadius?.anchorCount).toBeGreaterThan(0);
    expect(outcome.confirmation.policy.controls).toBe('cancel_and_confirm');
    // "Reversibility stated in words, and true."
    expect(outcome.confirmation.reversible).toBe(true);
  });

  it('refuses the commit when the preview was never shown', async () => {
    const { session: s, outcome, committed } = stageTier2();
    await expect(
      s.commit(outcome.proposal.proposalId, fullAck({ livePreviewShown: false })),
    ).rejects.toThrow(/livePreview.notShown/);
    expect(committed).toEqual([]);
  });

  it('refuses the commit when the confirm control was clicked through immediately', async () => {
    const { session: s, outcome, committed } = stageTier2();
    await expect(
      s.commit(outcome.proposal.proposalId, fullAck({ openForMs: 0 })),
    ).rejects.toBeInstanceOf(ConfirmationRefusedError);
    expect(committed).toEqual([]);
  });

  it('commits once every requirement is met', async () => {
    const { session: s, outcome, committed } = stageTier2();
    await s.commit(outcome.proposal.proposalId, fullAck());
    expect(committed.length).toBe(1);
  });

  it('refuses to batch a tier 2 operation', () => {
    expect(() => assertBatchable(1)).not.toThrow();
    expect(() => assertBatchable(2)).toThrow(TierPolicyError);
    expect(() => assertBatchable(3)).toThrow(TierPolicyError);
  });

  it('refuses to put a tier 2 option in a multi-select set', () => {
    expect(() => assertMultiSelectable(1)).not.toThrow();
    expect(() => assertMultiSelectable(2)).toThrow(TierPolicyError);
  });
});

describe('tier 3 is unreachable from the conversation, in any phrasing', () => {
  it('refuses to offer a tier 3 operation from the dialogue surface', () => {
    expect(() => assertOfferable(3, 'dialogue')).toThrow(TierPolicyError);
    expect(() => assertOfferable(3, 'world_index')).not.toThrow();
    expect(tierPolicy(3).offerableFrom).toEqual(['world_index']);
    expect(tierPolicy(3).offerableByInitiative).toBe(false);
  });

  it('rejects a turn that somehow carries a tier 3 option', () => {
    const deleteDraft = makeDraft({
      draftId: 'draft-delete',
      origin: 'user_choice',
      rawUtterance: '',
      subjectEntityId: 'ent-julie',
      operations: [draftOperation('delete', ['a1'], ['i1'], {})],
      provenanceSummaryKey: 'provenance.x',
    });
    const turn: Turn = {
      turnId: 'turn-x',
      intent: 'resolve_identity',
      subjectEntityId: 'ent-julie',
      subjectAnchorId: 'a1',
      utteranceKey: 'utterance.resolveIdentity',
      utterance: null,
      evidence: [],
      choiceSet: {
        mode: 'single',
        submitRequired: false,
        options: [
          {
            optionId: 'x:forget',
            kind: 'exclusive',
            textKey: 'option.forgetThisPerson',
            phrasing: null,
            available: true,
            unavailableReasonKey: null,
            tier: 3,
            draft: deleteDraft,
            escape: null,
          },
        ],
      },
      freeTextAllowed: true,
      escapes: [
        {
          optionId: 'escape:skip',
          kind: 'escape',
          textKey: 'escape.skip',
          phrasing: null,
          available: true,
          unavailableReasonKey: null,
          tier: 0,
          draft: null,
          escape: 'skip',
        },
      ],
      stateVersion: 1,
    };
    expect(() => validateTurn(turn)).toThrow(TierPolicyError);
  });

  it('states what tier 3 must show, and the gate still refuses it in the MVP', async () => {
    const policy = tierPolicy(3);
    expect(policy.requiresTypedDisplayName).toBe(true);
    expect(policy.requiresMediaRetentionStatement).toBe(true);
    expect(policy.requiresCitationLossCount).toBe(true);
    expect(policy.inMvp).toBe(false);

    const unmet = unmetRequirements(
      3,
      fullAck({ typedDisplayName: 'wrong name' }, 'world_index'),
      'Julie',
    );
    expect(unmet).toContain('typedName.mismatch');
    expect(unmet).toContain('tier.outOfMvpCut');

    const { gate } = recordingGate();
    const proposal = finalizeDraft(
      makeDraft({
        draftId: 'draft-delete',
        origin: 'user_choice',
        rawUtterance: '',
        subjectEntityId: 'ent-julie',
        operations: [draftOperation('delete', [], [], {})],
        provenanceSummaryKey: 'provenance.x',
      }),
      'proposal-delete',
      'turn-x',
      11,
    );
    gate.stage(proposal);
    await expect(gate.commit('proposal-delete')).rejects.toBeInstanceOf(ProposalGateError);
  });

  it('never marks a delete reversible', () => {
    const draft = makeDraft({
      draftId: 'draft-delete',
      origin: 'user_choice',
      rawUtterance: '',
      subjectEntityId: 'ent-julie',
      operations: [draftOperation('delete', [], [], {})],
      provenanceSummaryKey: 'provenance.x',
    });
    expect(draft.reversible).toBe(false);
  });
});

describe('tier 1 is one click and no typing', () => {
  it('needs no blast radius, no preview and no delay', async () => {
    const policy = tierPolicy(1);
    expect(policy.controls).toBe('single_save');
    expect(policy.requiresBlastRadius).toBe(false);
    expect(policy.confirmEnabledAfterMs).toBe(0);
    expect(policy.undoToast).toBe(true);

    const { gate, committed } = recordingGate(SNAPSHOT_T2.stateVersion);
    const s = new CompanionSession({ snapshot: SNAPSHOT_T2, gate, ids: sequentialIds() });
    s.advance(MOCK_NOW_MS, 'ent-julie');
    const outcome = s.select('confirm_continuity:differentPeople', MOCK_NOW_MS);
    if (outcome.kind !== 'awaiting_confirmation') throw new Error('expected a proposal');
    expect(outcome.proposal.maxTier).toBe(1);

    await s.commit(
      outcome.proposal.proposalId,
      fullAck({ openForMs: 0, blastRadiusShown: false, livePreviewShown: false }),
    );
    expect(committed.length).toBe(1);
  });
});

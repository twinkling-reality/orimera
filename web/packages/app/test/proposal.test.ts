import { describe, expect, it } from 'vitest';
import { makeDraft, draftOperation } from '@exulanica/companion-runtime';

import { toUpdateProposal } from '../src/proposal.js';

/**
 * The translation from a drafted proposal to one the gate can commit.
 *
 * What it REFUSES is the point. The API's identity surface has no rename, and `merge` and `split`
 * are drafted in a vocabulary this file cannot convert without deciding a semantic question it
 * has no business deciding. Both are refused with a reason at the moment the control is used,
 * rather than left to fail after the user has read a confirmation and pressed confirm.
 */

const ids = (kind: string) => `${kind}-1`;

function nameDraft(displayName: string) {
  return makeDraft({
    draftId: ids('draft'),
    origin: 'user_utterance',
    rawUtterance: displayName,
    subjectEntityId: 'e1',
    operations: [
      draftOperation('name', ['anc-1'], ['isl-1'], { predicateKey: 'name_is', displayName }),
    ],
    provenanceSummaryKey: 'provenance.userEditedName',
  });
}

const context = { proposalId: 'p1', turnId: 't1', stateVersion: 9 };

describe('a draft becomes a proposal the gate can commit', () => {
  it('translates a name into the wire vocabulary the endpoint takes', () => {
    const result = toUpdateProposal(nameDraft('Julie'), { ...context, occurrenceId: 'occ-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.operations[0]!.payload).toEqual({
      occurrence_id: 'occ-1',
      display_name: 'Julie',
    });
  });

  it('carries the state version so the gate can expire it', () => {
    const result = toUpdateProposal(nameDraft('Julie'), { ...context, occurrenceId: 'occ-1' });
    expect(result.ok && result.proposal.expiresAtStateVersion).toBe(9);
  });

  it("keeps the user's words verbatim rather than a summary of them", () => {
    const result = toUpdateProposal(nameDraft('the courtyard fountain'), {
      ...context,
      occurrenceId: 'occ-1',
    });
    expect(result.ok && result.proposal.rawUtterance).toBe('the courtyard fountain');
  });

  it('refuses a name with no detection, because this API has no rename', () => {
    const result = toUpdateProposal(nameDraft('Julie'), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no rename endpoint');
  });

  it('refuses an operation it cannot translate rather than half-applying the proposal', () => {
    const draft = makeDraft({
      draftId: ids('draft'),
      origin: 'user_choice',
      rawUtterance: '',
      subjectEntityId: 'e1',
      operations: [
        draftOperation('name', ['anc-1'], ['isl-1'], {
          predicateKey: 'name_is',
          displayName: 'Julie',
        }),
        draftOperation('merge', ['anc-1'], ['isl-1'], { fromEntityIds: ['e1'], occurrenceIds: [] }),
      ],
      provenanceSummaryKey: 'provenance.userMergedEntities',
    });
    const result = toUpdateProposal(draft, { ...context, occurrenceId: 'occ-1' });
    // The whole proposal is refused, not the operation. A proposal that applied its first
    // operation and failed on its second would leave the graph in a state no event describes.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('merge');
  });
});

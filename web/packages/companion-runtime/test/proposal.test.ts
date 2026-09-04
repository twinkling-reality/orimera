import { describe, expect, it } from 'vitest';
import { ProposalGateError } from '@exulanica/graph-client/mutations';
import {
  BAND_ORDER,
  CompanionSession,
  ConfirmationRefusedError,
  MOCK_NOW_MS,
  SNAPSHOT_T1,
  SNAPSHOT_T2,
  SNAPSHOT_T3,
  buildConfirmation,
  draftFromParse,
  parseUtterance,
  sequentialIds,
  withMatchProposals,
} from '../src/index.js';
import { fullAck, recordingGate } from './harness.js';

const session = (snapshot = SNAPSHOT_T1, stateVersion = snapshot.stateVersion) => {
  const { gate, committed } = recordingGate(stateVersion);
  return {
    committed,
    gate,
    session: new CompanionSession({ snapshot, gate, ids: sequentialIds() }),
  };
};

describe('nothing reaches the graph without an explicit confirmation (5.1)', () => {
  it('a free-text answer produces a proposal and writes nothing', async () => {
    const { session: s, committed } = session(SNAPSHOT_T1);
    s.advance(MOCK_NOW_MS, 'ent-julie');

    const outcome = s.say('That is Julie, a close friend I met in college', MOCK_NOW_MS);
    expect(outcome.kind).toBe('awaiting_confirmation');
    if (outcome.kind !== 'awaiting_confirmation') return;

    // The user's words are retained verbatim, never paraphrased away.
    expect(outcome.proposal.rawUtterance).toBe(
      'That is Julie, a close friend I met in college',
    );
    expect(outcome.proposal.origin).toBe('user_utterance');
    expect(committed).toEqual([]);

    await s.commit(outcome.proposal.proposalId, fullAck());
    expect(committed.map((p) => p.proposalId)).toEqual([outcome.proposal.proposalId]);
  });

  it('a single click on "Yes, the same person" also produces a proposal, not a write', () => {
    const { session: s, committed } = session(SNAPSHOT_T2);
    s.advance(MOCK_NOW_MS, 'ent-julie');
    const outcome = s.select('confirm_continuity:samePerson', MOCK_NOW_MS);

    expect(outcome.kind).toBe('awaiting_confirmation');
    expect(committed).toEqual([]);
  });

  it('the gate refuses a proposal that was never staged', async () => {
    const { gate } = recordingGate();
    await expect(gate.commit('proposal-that-does-not-exist')).rejects.toBeInstanceOf(
      ProposalGateError,
    );
  });

  it('cancelling leaves nothing to roll back', async () => {
    const { session: s, gate, committed } = session(SNAPSHOT_T2);
    s.advance(MOCK_NOW_MS, 'ent-julie');
    const outcome = s.select('confirm_continuity:samePerson', MOCK_NOW_MS);
    if (outcome.kind !== 'awaiting_confirmation') throw new Error('expected a proposal');

    s.cancel(outcome.proposal.proposalId);
    expect(gate.isPending(outcome.proposal.proposalId)).toBe(false);
    await expect(s.commit(outcome.proposal.proposalId, fullAck())).rejects.toBeInstanceOf(
      ConfirmationRefusedError,
    );
    expect(committed).toEqual([]);
  });

  it('drops a staged proposal when the graph moves underneath it', () => {
    const { session: s, gate } = session(SNAPSHOT_T2);
    s.advance(MOCK_NOW_MS, 'ent-julie');
    const outcome = s.select('confirm_continuity:samePerson', MOCK_NOW_MS);
    if (outcome.kind !== 'awaiting_confirmation') throw new Error('expected a proposal');

    s.observeSnapshot(SNAPSHOT_T3);
    expect(s.pendingProposalIds).toEqual([]);
    expect(gate.isPending(outcome.proposal.proposalId)).toBe(false);
  });

  it('a tier 0 option advances the conversation and records no proposal', () => {
    const { session: s, committed } = session(SNAPSHOT_T2);
    s.advance(MOCK_NOW_MS, 'ent-julie');
    const outcome = s.select('confirm_continuity:showBothMoments', MOCK_NOW_MS);
    expect(outcome.kind).toBe('advanced');
    expect(s.pendingProposalIds).toEqual([]);
    expect(committed).toEqual([]);
  });

  it('refuses to commit one checkbox of a multi-select set on click', () => {
    const { session: s } = session(withMatchProposals(SNAPSHOT_T1, []));
    s.advance(MOCK_NOW_MS, 'ent-mira');
    const outcome = s.select('enrich_relation:relation.friend', MOCK_NOW_MS);
    expect(outcome).toEqual({ kind: 'refused', reasonKey: 'refused.useSubmit' });
  });

  it('merges a submitted multi-select set into one proposal', () => {
    const { session: s } = session(withMatchProposals(SNAPSHOT_T1, []));
    s.advance(MOCK_NOW_MS, 'ent-mira');
    const outcome = s.submit(
      ['enrich_relation:relation.friend', 'enrich_relation:relation.colleague'],
      MOCK_NOW_MS,
    );
    expect(outcome.kind).toBe('awaiting_confirmation');
    if (outcome.kind !== 'awaiting_confirmation') return;
    expect(outcome.proposal.operations.length).toBe(2);
    expect(outcome.proposal.maxTier).toBe(1);
  });
});

describe('the free-text parser guesses nothing it was not told', () => {
  it('extracts a name and a relation and keeps the rest verbatim', () => {
    const parse = parseUtterance('That is Julie, a close friend I met in college');
    expect(parse.name).toBe('Julie');
    expect(parse.relation).toBe('friend');
    expect(parse.residual).toBe('a close friend I met in college');
  });

  it('refuses to treat a bare capitalised word as a name', () => {
    const parse = parseUtterance('Julie');
    expect(parse.name).toBeNull();
    expect(
      draftFromParse(parse, {
        ids: sequentialIds(),
        subjectEntityId: 'ent-julie',
        anchorIds: [],
        islandIds: [],
        captureEvidence: [],
      }),
    ).toBeNull();
  });
});

describe('the confirmation surface: four bands, fixed order, band 4 never omitted', () => {
  const built = () => {
    const { session: s } = session(SNAPSHOT_T1);
    s.advance(MOCK_NOW_MS, 'ent-julie');
    const outcome = s.say('That is Julie, a close friend I met in college', MOCK_NOW_MS);
    if (outcome.kind !== 'awaiting_confirmation') throw new Error('expected a proposal');
    return outcome.confirmation;
  };

  it('always renders exactly four bands in the documented order', () => {
    const confirmation = built();
    expect(confirmation.bands.map((b) => b.band)).toEqual([...BAND_ORDER]);
    expect(confirmation.bands.every((b) => b.omitted === false)).toBe(true);
  });

  it('quotes the user verbatim in band 1 and makes those rows editable and removable', () => {
    const [told] = built().bands;
    expect(told.rows.length).toBeGreaterThan(0);
    for (const row of told.rows) {
      expect(row.verbatim).toBe('That is Julie, a close friend I met in college');
      expect(row.editable).toBe(true);
      expect(row.removable).toBe(true);
    }
  });

  it('separates capture support from inference, and only inference is rejectable', () => {
    const [, captures, inferred] = built().bands;
    expect(captures.rows.every((r) => r.rejectable === false && r.confidence === null)).toBe(true);
    expect(inferred.rows.length).toBeGreaterThan(0);
    expect(inferred.rows.every((r) => r.rejectable === true)).toBe(true);
    expect(inferred.rows.every((r) => r.methodKey !== null)).toBe(true);
  });

  it('renders band 4 even when there is nothing left to say', () => {
    const confirmation = built();
    const unknown = confirmation.bands[3];
    expect(unknown.band).toBe('unknown');
    expect(unknown.rows.length).toBeGreaterThan(0);
  });

  it('puts external-web knowledge in its own block, barred from historical claims', () => {
    const harbour = SNAPSHOT_T2.entities.find((e) => e.entityId === 'ent-harbour');
    if (harbour === undefined) throw new Error('fixture lost ent-harbour');
    const draft = draftFromParse(parseUtterance('This is Old Harbour'), {
      ids: sequentialIds(),
      subjectEntityId: 'ent-harbour',
      anchorIds: [],
      islandIds: [],
      captureEvidence: [],
    });
    if (draft === null) throw new Error('expected a draft');

    const confirmation = buildConfirmation({
      draft,
      entity: harbour,
      surface: 'world_index',
    });
    expect(confirmation.external?.barredFromHistoricalClaims).toBe(true);
    expect(confirmation.external?.rows[0]?.retrievedAtMs).toBeGreaterThan(0);
    // External is not smuggled into any of the four bands.
    for (const band of confirmation.bands) {
      expect(band.rows.some((r) => r.labelKey.startsWith('row.external'))).toBe(false);
    }
  });
});

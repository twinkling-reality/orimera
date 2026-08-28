import { describe, expect, it } from 'vitest';
import {
  CompanionSession,
  EMPTY_MEMORY,
  MOCK_MATCHES,
  MOCK_NOW_MS,
  SNAPSHOT_T1,
  SNAPSHOT_T2,
  SNAPSHOT_T3,
  applyPhrasing,
  buildPool,
  escapeOptions,
  generateTurn,
  phrasingRequest,
  prune,
  rankQuestions,
  recordEscape,
  sequentialIds,
  withMatchProposals,
} from '../src/index.js';
import type { Turn } from '../src/index.js';
import { recordingGate } from './harness.js';

const optionIds = (turn: Turn): readonly string[] =>
  (turn.choiceSet?.options ?? []).map((o) => o.optionId);

describe('the option pool evolves like a dialogue tree, not a form', () => {
  /**
   * interaction-model.md 4.4, the worked example, reproduced turn by turn. The property under
   * test is not that the text differs: it is that the OPTION SET differs, and that each new
   * option was UNREACHABLE on the previous turn because the graph did not yet support it.
   */
  it('reproduces the worked example T1 -> T2 -> T3', () => {
    const ids = sequentialIds();
    const focus = 'ent-julie';

    const t1 = generateTurn({
      snapshot: SNAPSHOT_T1,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids,
      focusEntityId: focus,
    });
    expect(t1.intent).toBe('resolve_identity');
    expect(optionIds(t1)).toEqual([
      'resolve_identity:giveName',
      'resolve_identity:alreadyNamed',
      'resolve_identity:notThisKind',
    ]);

    // The user types a name and a relationship. The graph moves.
    const t2 = generateTurn({
      snapshot: SNAPSHOT_T2,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids,
      focusEntityId: focus,
    });
    expect(t2.intent).toBe('confirm_continuity');
    expect(optionIds(t2)).toEqual([
      'confirm_continuity:samePerson',
      'confirm_continuity:differentPeople',
      'confirm_continuity:showBothMoments',
    ]);

    // Yes. The link changed the graph and made a new question reachable.
    const t3 = generateTurn({
      snapshot: SNAPSHOT_T3,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids,
      focusEntityId: focus,
    });
    expect(t3.intent).toBe('enrich_relation');
    expect(t3.utteranceKey).toBe('utterance.nameScope');
    expect(optionIds(t3)).toEqual([
      'enrich_relation:useEverywhere',
      'enrich_relation:differentName',
      'enrich_relation:keepPrivate',
    ]);

    // No option survives from one turn to the next. This is the whole claim.
    expect(new Set(optionIds(t1)).size).toBe(3);
    for (const later of [t2, t3]) {
      for (const id of optionIds(later)) expect(optionIds(t1)).not.toContain(id);
    }
  });

  it('does not offer the name-scope question until the entity actually spans two regions', () => {
    // T2 Julie has a name but one region, so the question is structurally unreachable.
    const t2 = generateTurn({
      snapshot: withMatchProposals(SNAPSHOT_T2, []),
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
      focusEntityId: 'ent-julie',
    });
    expect(t2.utteranceKey).not.toBe('utterance.nameScope');
  });

  it('moves on to a different question when the same graph is asked twice', () => {
    const ids = sequentialIds();
    const { gate } = recordingGate();
    const session = new CompanionSession({ snapshot: SNAPSHOT_T1, gate, ids });

    const first = session.advance(MOCK_NOW_MS);
    const second = session.advance(MOCK_NOW_MS);

    // The snapshot did not change. Memory did, because the first question was delivered.
    expect(second.turnId).not.toBe(first.turnId);
    expect([second.intent, second.subjectEntityId]).not.toEqual([first.intent, first.subjectEntityId]);
  });

  it('drops a question the user escaped, and says which escape did it', () => {
    const before = rankQuestions({
      snapshot: SNAPSHOT_T1,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
    });
    expect(before[0]?.entity.entityId).toBe('ent-julie');

    const memory = recordEscape(EMPTY_MEMORY, {
      escape: 'skip',
      intent: 'resolve_identity',
      entityId: 'ent-julie',
      atMs: MOCK_NOW_MS,
    });
    const after = rankQuestions({
      snapshot: SNAPSHOT_T1,
      memory,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
    });
    expect(after.some((c) => c.entity.entityId === 'ent-julie')).toBe(false);
  });
});

describe('stage 3 pruning is deterministic and happens before any model sees the pool', () => {
  const ctx = (matches: readonly (typeof MOCK_MATCHES)['julieHarbour'][]) => {
    const snapshot = withMatchProposals(SNAPSHOT_T2, matches);
    const subject = snapshot.entities.find((e) => e.entityId === 'ent-mira');
    if (subject === undefined) throw new Error('fixture lost ent-mira');
    return { snapshot, nowMs: MOCK_NOW_MS, ids: sequentialIds(), subject };
  };

  it('drops an option targeting a deleted entity rather than greying it out', () => {
    const c = ctx([MOCK_MATCHES.miraDeleted]);
    const options = prune('confirm_continuity', c, buildPool('confirm_continuity', c));
    // Both consequential options named the deleted entity, so only the tier 0 look-at remains.
    expect(options.map((o) => o.optionId)).toEqual(['confirm_continuity:showBothMoments']);
  });

  it('keeps a merge across an asserted-distinct pair, unavailable, with the reason stated', () => {
    const c = ctx([MOCK_MATCHES.miraAssertedDistinct]);
    const options = prune('confirm_continuity', c, buildPool('confirm_continuity', c));
    const same = options.find((o) => o.optionId === 'confirm_continuity:samePerson');
    expect(same?.available).toBe(false);
    expect(same?.unavailableReasonKey).toBe('unavailable.alreadyAssertedDistinct');
    // Yarn Spinner semantics: still delivered, so the user can see the system remembers.
    expect(options.length).toBe(3);
  });

  it('marks a candidate rejected on the same evidence unavailable rather than re-asking it', () => {
    const c = ctx([MOCK_MATCHES.miraSuppressed]);
    const options = prune('confirm_continuity', c, buildPool('confirm_continuity', c));
    const same = options.find((o) => o.optionId === 'confirm_continuity:samePerson');
    expect(same?.available).toBe(false);
    expect(same?.unavailableReasonKey).toBe('unavailable.rejectedOnTheSameEvidence');
  });
});

describe('escapes and choice modes', () => {
  it('offers all four escapes on every turn, at tier 0', () => {
    const turn = generateTurn({
      snapshot: SNAPSHOT_T1,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
    });
    expect(turn.escapes.map((e) => e.escape)).toEqual([
      'not_sure',
      'skip',
      'later',
      'wrong_question',
    ]);
    expect(turn.escapes.every((e) => e.tier === 0 && e.available)).toBe(true);
    expect(escapeOptions().length).toBe(4);
  });

  it('offers free text on every turn, including the acknowledge turn', () => {
    const empty = {
      ...SNAPSHOT_T1,
      entities: [],
      occurrences: [],
      matchProposals: [],
    };
    const turn = generateTurn({
      snapshot: empty,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
    });
    expect(turn.intent).toBe('acknowledge');
    expect(turn.choiceSet).toBeNull();
    expect(turn.freeTextAllowed).toBe(true);
    expect(turn.escapes.length).toBe(4);
  });

  it('uses multi-select with an explicit submit for attribute gathering, and only tier 1', () => {
    const turn = generateTurn({
      snapshot: withMatchProposals(SNAPSHOT_T1, []),
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
      focusEntityId: 'ent-mira',
    });
    expect(turn.intent).toBe('enrich_relation');
    expect(turn.choiceSet?.mode).toBe('multi');
    expect(turn.choiceSet?.submitRequired).toBe(true);
    expect(turn.choiceSet?.options.every((o) => o.tier <= 1)).toBe(true);
  });
});

describe('the phrasing seam: the model writes words, the code writes consequences', () => {
  it('shows a model no tier, no draft and no ids beyond the option id', () => {
    const turn = generateTurn({
      snapshot: SNAPSHOT_T2,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
      focusEntityId: 'ent-julie',
    });
    const request = phrasingRequest(turn);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('tier');
    expect(serialized).not.toContain('draft');
    expect(serialized).not.toContain('anc-');
  });

  it('changes only the phrasing, never a consequence', () => {
    const turn = generateTurn({
      snapshot: SNAPSHOT_T2,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
      focusEntityId: 'ent-julie',
    });
    const phrased = applyPhrasing(turn, {
      utterance: 'Is she also the person in the harbour set?',
      options: { 'confirm_continuity:samePerson': 'Yes, the same person' },
    });

    const stripPhrasing = (t: typeof turn) =>
      JSON.stringify({
        ...t,
        utterance: null,
        choiceSet: t.choiceSet && {
          ...t.choiceSet,
          options: t.choiceSet.options.map((o) => ({ ...o, phrasing: null })),
        },
        escapes: t.escapes.map((o) => ({ ...o, phrasing: null })),
      });

    expect(stripPhrasing(phrased)).toBe(stripPhrasing(turn));
    expect(phrased.choiceSet?.options[0]?.phrasing).toBe('Yes, the same person');
  });

  it('refuses a phrasing for an option the turn does not offer', () => {
    const turn = generateTurn({
      snapshot: SNAPSHOT_T1,
      memory: EMPTY_MEMORY,
      nowMs: MOCK_NOW_MS,
      ids: sequentialIds(),
    });
    expect(() =>
      applyPhrasing(turn, { utterance: 'x', options: { 'confirm_continuity:merge': 'Merge them' } }),
    ).toThrow(/does not offer/);
  });
});

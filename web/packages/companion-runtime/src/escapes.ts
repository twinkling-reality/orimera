import type { EntityIdRef } from '@orimera/graph-client';
import type { ProposalDraft } from './draft.js';
import { draftOperation, makeDraft } from './draft.js';
import type { IdFactory } from './ids.js';
import type { Intent } from './intent.js';
import type { EscapeKind, TurnOption } from './turn.js';

/**
 * THE FOUR ESCAPES (interaction-model.md 4.3), always present, never penalized.
 *
 * | Escape                     | Recorded as                              | Effect                          |
 * | Not sure                   | An explicit `uncertain` assertion        | Lowers re-ask priority, 14 days |
 * | Skip                       | The question is marked deferred          | 7 day cooldown; initiative x2   |
 * | Later                      | The conversation is dismissed            | Closes the thread, no penalty   |
 * | That is the wrong question | A negative signal on (intent, entity)    | Framing channel                 |
 *
 * The fourth "is the underrated one and it is cheap to build. Without it, a user whose situation
 * the system has mis-modelled has no move except to keep skipping, and skip is indistinguishable
 * from disinterest."
 *
 * All four are tier 0 as CONTROLS: choosing one is not a consequence the user has to confirm.
 * The lasting effects live in memory.ts, which is where the cooldown arithmetic is tested.
 */

export const ESCAPE_ORDER: readonly EscapeKind[] = Object.freeze([
  'not_sure',
  'skip',
  'later',
  'wrong_question',
]);

const ESCAPE_TEXT_KEY: Readonly<Record<EscapeKind, string>> = Object.freeze({
  not_sure: 'escape.notSure',
  skip: 'escape.skip',
  later: 'escape.later',
  wrong_question: 'escape.wrongQuestion',
});

export function escapeOption(escape: EscapeKind): TurnOption {
  return Object.freeze({
    optionId: `escape:${escape}`,
    kind: 'escape' as const,
    textKey: ESCAPE_TEXT_KEY[escape],
    phrasing: null,
    // Always available. An escape that could be greyed out is not an escape.
    available: true,
    unavailableReasonKey: null,
    tier: 0 as const,
    draft: null,
    escape,
  });
}

export function escapeOptions(): readonly TurnOption[] {
  return Object.freeze(ESCAPE_ORDER.map(escapeOption));
}

/**
 * "Not sure" produces DATA, not a null.
 *
 * 4.3 records it as "an explicit `uncertain` assertion, WHICH IS DATA RATHER THAN A NULL". That
 * is a graph write, and 5.1 says no path writes to the graph without a proposal, so it is a
 * proposal. It is tier 1, which per 5.3 is "a single Save control, commits immediately, short
 * undo toast" - and the Not sure button IS that control. The user's click is the explicit
 * confirmation; they are not asked to confirm that they are unsure.
 *
 * NOTE FOR THE SPEC OWNER: interaction-model.md does not state which tier recording an
 * `uncertain` assertion carries. Tier 1 is inferred here from the shape of the interaction (one
 * click, fully reversible, affects nothing outside this entity) and from the requirement that an
 * escape "costs zero input". If that is wrong, this is the one line to change.
 *
 * The other three escapes write no assertion: a deferral, a dismissal and a framing signal are
 * facts about the CONVERSATION, not claims about the world, and they belong in conversation
 * memory rather than in the entity graph.
 */
export function escapeDraft(
  escape: EscapeKind,
  intent: Intent,
  entityId: EntityIdRef | null,
  rawUtterance: string,
  ids: IdFactory,
): ProposalDraft | null {
  if (escape !== 'not_sure') return null;
  return makeDraft({
    draftId: ids('draft'),
    origin: 'user_choice',
    rawUtterance,
    subjectEntityId: entityId,
    operations: [
      draftOperation('note', [], [], {
        predicateKey: 'uncertain',
        intent,
        entityId,
      }),
    ],
    provenanceSummaryKey: 'provenance.userSaidNotSure',
  });
}

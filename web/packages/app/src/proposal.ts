/**
 * A drafted proposal becomes the one the gate can commit.
 *
 * `companion-runtime` drafts in the product's vocabulary (`displayName`, `predicateKey`) and the
 * API takes the wire vocabulary (`display_name`, `occurrence_id`). Something has to translate,
 * and the composition root is the only module that legitimately knows both: `companion-runtime`
 * must stay runnable headless with no transport, and `graph-client` must not learn what a draft
 * is or the layering inverts.
 *
 * **What this file refuses to translate matters more than what it translates.** The API's
 * identity surface is seven endpoints and there is no rename. `name_occurrence` names an
 * occurrence and creates the entity; naming an occurrence already linked to a named entity is an
 * `AlreadyIdentified` conflict. So an edit of an existing name has no endpoint, and this returns
 * a refusal that says so rather than building a proposal that would fail at the transport with a
 * 409 the user cannot act on. A missing capability stated is a smaller problem than a control
 * that looks available and is not.
 *
 * The gate then applies its own three refusals on top: not pending, expired, tier 3.
 */

import type { ProposalDraft } from '@exulanica/companion-runtime';
import type { ProposalOperation, UpdateProposal } from '@exulanica/graph-client';

export type Translation =
  | { readonly ok: true; readonly proposal: UpdateProposal }
  | { readonly ok: false; readonly reason: string };

export interface TranslationContext {
  readonly proposalId: string;
  readonly turnId: string;
  /** The graph version this was computed against. The gate expires it past this. */
  readonly stateVersion: number;
  /**
   * The occurrence a `name` operation is about.
   *
   * Required rather than derived from the draft's affected anchors, because an anchor id and an
   * occurrence id being the same string is a property of the current adapter and not a rule. A
   * caller that knows which detection the user pointed at should say so.
   */
  readonly occurrenceId?: string;
}

export function toUpdateProposal(
  draft: ProposalDraft,
  context: TranslationContext,
): Translation {
  const operations: ProposalOperation[] = [];
  for (const operation of draft.operations) {
    const translated = translate(operation, context);
    if (!translated.ok) return translated;
    operations.push(translated.operation);
  }
  return {
    ok: true,
    proposal: {
      proposalId: context.proposalId,
      turnId: context.turnId,
      origin: draft.origin,
      rawUtterance: draft.rawUtterance,
      operations,
      provenanceSummary: draft.provenanceSummaryKey,
      maxTier: draft.maxTier,
      reversible: draft.reversible,
      expiresAtStateVersion: context.stateVersion,
    },
  };
}

type TranslatedOperation =
  | { readonly ok: true; readonly operation: ProposalOperation }
  | { readonly ok: false; readonly reason: string };

function translate(
  operation: ProposalDraft['operations'][number],
  context: TranslationContext,
): TranslatedOperation {
  const base = {
    op: operation.op,
    tier: operation.tier,
    affectedAnchorIds: operation.affectedAnchorIds,
    affectedIslandIds: operation.affectedIslandIds,
  };

  switch (operation.op) {
    case 'name': {
      const occurrenceId = context.occurrenceId;
      if (occurrenceId === undefined) {
        return {
          ok: false,
          reason:
            'this API names an occurrence, not an entity, so a name needs the detection it is ' +
            'about. There is no rename endpoint: changing an existing name is not something ' +
            'this instance can do yet.',
        };
      }
      const displayName = operation.payload['displayName'];
      if (typeof displayName !== 'string' || displayName.length === 0) {
        return { ok: false, reason: 'a name proposal carries no name' };
      }
      return {
        ok: true,
        operation: { ...base, payload: { occurrence_id: occurrenceId, display_name: displayName } },
      };
    }
    case 'merge': {
      // `draftMerge` now emits the endpoint's own vocabulary, so this translates rather than
      // renames. It used to emit a flat list of entity ids, and which one survived was a
      // semantic question this file could not answer by renaming a key: guessing it would merge
      // the wrong way round, and a merge that went the wrong way is undoable only if somebody
      // notices. The survivor is chosen by the user, upstream, and carried here.
      const target = operation.payload['target'];
      const sources = operation.payload['sources'];
      if (typeof target !== 'string' || !Array.isArray(sources) || sources.length === 0) {
        return { ok: false, reason: 'a merge proposal names no surviving record' };
      }
      return {
        ok: true,
        operation: { ...base, payload: { target, sources } },
      };
    }
    case 'split': {
      const entityId = operation.payload['entityId'];
      const occurrenceIds = operation.payload['occurrenceIds'];
      if (typeof entityId !== 'string' || !Array.isArray(occurrenceIds)) {
        return { ok: false, reason: 'a split proposal names no record to split' };
      }
      if (occurrenceIds.length === 0) {
        return { ok: false, reason: 'a split with no detections moved is not a split' };
      }
      return {
        ok: true,
        operation: {
          ...base,
          payload: { entity_id: entityId, occurrence_ids: occurrenceIds },
        },
      };
    }
    default:
      // Refused rather than passed through, and refused HERE rather than at the transport, so a
      // user never presses confirm on something that fails afterwards.
      return {
        ok: false,
        reason: `a ${operation.op} proposal is not wired to this instance's API yet`,
      };
  }
}

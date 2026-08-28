import type { EntityIdRef, EvidenceHandle } from '@orimera/graph-client';
import type { ProposalDraft } from './draft.js';
import { draftOperation, makeDraft } from './draft.js';
import type { IdFactory } from './ids.js';
import { PREDICATES } from './pool.js';

/**
 * FREE TEXT -> DRAFT (interaction-model.md 4.3).
 *
 * "Free text input is always available. It is parsed into the SAME update proposal draft that a
 * choice would produce and goes through the IDENTICAL confirmation flow. No path writes to the
 * graph without a proposal."
 *
 * The parse is deterministic and deliberately conservative. That is not a limitation to be fixed
 * later with a model: 4.4 puts the proposed update on the code side of the safety boundary, so
 * an extractor that can invent a relation the user did not state is exactly the thing the
 * boundary exists to prevent. A model may eventually pre-segment the sentence, but it would have
 * to hand its output back through this constructor and its closed relation vocabulary.
 *
 * What the parser cannot extract is not guessed. It becomes a row in "What I still do not know"
 * (5.2 band 4), which is the band the document says is NEVER OMITTED, EVEN WHEN SHORT.
 */

export interface UtteranceParse {
  /** Verbatim. Retained and never paraphrased away (5.1). */
  readonly rawUtterance: string;
  readonly name: string | null;
  /** One of the closed relation vocabulary values, or null. Never a free-form relation string. */
  readonly relation: string | null;
  /**
   * Everything the parser did not claim to understand, kept as the user's own words. Stored as a
   * note rather than dropped, because "a close friend I MET IN COLLEGE" carries context the
   * capture could not know and the schema has no column for.
   */
  readonly residual: string | null;
}

/** The closed relation vocabulary. Longest phrases first so "close friend" beats "friend". */
const RELATION_PATTERNS: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/\b(?:wife|husband|partner|girlfriend|boyfriend|spouse)\b/i, 'partner'],
  [/\b(?:colleague|coworker|co-worker|workmate|manager)\b/i, 'colleague'],
  [
    /\b(?:mother|mum|mom|father|dad|sister|brother|cousin|aunt|uncle|niece|nephew|grandmother|grandfather|family)\b/i,
    'family',
  ],
  [/\bfriend\b/i, 'friend'],
]);

/**
 * Introducers the parser will accept before a name.
 *
 * The introducers are spelled with explicit case classes rather than an `i` flag, because the
 * flag would also relax the capital letter the NAME group requires, and that capital is the only
 * thing separating "that is Julie" from "that is julie's bike".
 *
 * A bare capitalized word is NOT treated as a name. "Julie" alone could be a place, and guessing
 * wrong writes a person's name onto the wrong entity, which id-6 exists to prevent
 * ("defamation-by-mismatch ... is a live risk at 60 percent open-set accuracy").
 */
const NAME_PATTERN =
  /\b(?:[Tt]hat(?:'s| is)|[Tt]his is|[Ii]t(?:'s| is)|(?:[Hh]er|[Hh]is|[Tt]heir) name is|(?:[Ss]he|[Hh]e|[Tt]hey) (?:is|are) called|[Cc]all (?:her|him|them))\s+([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*)*)/u;

export function parseUtterance(rawUtterance: string): UtteranceParse {
  const text = rawUtterance.trim();

  const nameMatch = NAME_PATTERN.exec(text);
  const name = nameMatch?.[1]?.replace(/[.,;:!?]+$/u, '').trim() ?? null;

  let relation: string | null = null;
  for (const [pattern, value] of RELATION_PATTERNS) {
    if (pattern.test(text)) {
      relation = value;
      break;
    }
  }

  // The residual is whatever follows the first clause boundary: the part the user added because
  // they wanted it recorded, not because a form asked for it.
  const comma = text.indexOf(',');
  const residual = comma >= 0 ? text.slice(comma + 1).trim() : null;

  return Object.freeze({
    rawUtterance,
    name: name === '' ? null : name,
    relation,
    residual: residual === null || residual === '' ? null : residual,
  });
}

export interface ParseDraftContext {
  readonly ids: IdFactory;
  readonly subjectEntityId: EntityIdRef;
  readonly anchorIds: readonly string[];
  readonly islandIds: readonly string[];
  readonly captureEvidence: readonly EvidenceHandle[];
}

/**
 * Turn a parse into a draft, or null when the parser understood nothing.
 *
 * A null return is a real outcome and the caller must handle it by asking rather than by
 * committing an empty proposal. `makeDraft` refuses zero operations for the same reason.
 *
 * The name operation touches every anchor the entity occupies, so an entity spanning two islands
 * makes naming a TIER 2 operation with a blast radius and a live preview, automatically, with no
 * special case anywhere. That is `deriveTier` doing its job: "any operation affecting more than
 * six anchors or spanning more than one region" (5.3).
 */
export function draftFromParse(
  parse: UtteranceParse,
  ctx: ParseDraftContext,
): ProposalDraft | null {
  const operations = [];

  if (parse.name !== null) {
    operations.push(
      draftOperation('name', ctx.anchorIds, ctx.islandIds, {
        predicateKey: PREDICATES.nameIs,
        displayName: parse.name,
      }),
    );
  }
  if (parse.relation !== null) {
    operations.push(
      draftOperation('relate', [], [], {
        predicateKey: PREDICATES.relationIs,
        value: parse.relation,
      }),
    );
  }
  if (parse.residual !== null) {
    operations.push(
      draftOperation('note', [], [], { predicateKey: 'note', text: parse.residual }),
    );
  }

  if (operations.length === 0) return null;

  return makeDraft({
    draftId: ctx.ids('draft'),
    origin: 'user_utterance',
    rawUtterance: parse.rawUtterance,
    subjectEntityId: ctx.subjectEntityId,
    operations,
    provenanceSummaryKey: 'provenance.userToldMe',
    captureEvidence: ctx.captureEvidence,
  });
}

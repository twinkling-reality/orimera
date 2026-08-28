import type { ConsequenceTier, EntityIdRef } from '@orimera/graph-client';
import type { Intent } from './intent.js';
import type { CompanionMemory } from './memory.js';
import { hardSuppression } from './memory.js';
import { tierPolicy } from './tiers.js';

/**
 * THE INITIATIVE GATE (interaction-model.md 5.5).
 *
 * The requirement this file exists to meet, from the brief: it must never turn exploration into
 * a questionnaire, and the policy must be EXPLICIT AND TESTABLE. So the policy is a list of
 * named gates evaluated in a fixed order, each returning a reason key, rather than a nest of
 * conditions inside the generator. Every gate below is one clause of 5.5, quoted at its check.
 *
 * There are two initiative channels and they are not the same thing:
 *
 *   AMBIENT   - always on, never interrupting, NO TEXT. An unresolved anchor swaps its breathing
 *               for a slower cooler pulse and its ground ring becomes dashed. Plus one global
 *               counter in the HUD. This ships in the MVP and is not gated at all.
 *   SPONTANEOUS - the Companion speaks without being asked. Gated hard, and OUT OF THE MVP CUT.
 */

export type InitiativeSetting = 'normal' | 'minimal' | 'off';

/**
 * 5.5: "Spontaneous initiative is out of the MVP cut for this reason; the ambient channel and
 * the counter ship."
 *
 * A constant rather than a deleted code path, because the RISK the document attaches to it is
 * that initiative tuning "is the most likely thing to feel wrong and cannot be validated without
 * real users". Keeping the gate written, tested and switched off is what makes turning it on
 * later an experiment instead of a rewrite.
 */
export const SPONTANEOUS_INITIATIVE_IN_MVP = false;

/** "never in the first 90 seconds of a session". */
export const SESSION_WARMUP_MS = 90_000;
/**
 * "never more than a small number of times per session and per hour". The document says "a small
 * number" and does not pick one. These are a DECISION: three in a session, two in any hour.
 */
export const MAX_SPEECH_PER_SESSION = 3;
export const MAX_SPEECH_PER_HOUR = 2;
export const HOUR_MS = 60 * 60 * 1000;
/**
 * The gap between two spontaneous utterances, before the Skip multiplier. A DECISION; the
 * document fixes only that a Skip DOUBLES it (4.3), which is the part encoded in memory.ts.
 */
export const BASE_INITIATIVE_COOLDOWN_MS = 5 * 60 * 1000;
/** "an offer, not a question, WHICH DISSOLVES IF IGNORED". A DECISION on how long that takes. */
export const OFFER_DISSOLVE_MS = 12_000;

export interface InitiativeContext {
  readonly nowMs: number;
  readonly sessionStartMs: number;
  /** 2.2 `traverse` with movement keys active. "never while the user is moving." */
  readonly userMoving: boolean;
  /** Section 8 formation is in progress somewhere. "never while a capture is forming." */
  readonly captureForming: boolean;
  /** The subject's anchor is in the current island and visible. "never about a subject that is not present." */
  readonly subjectPresent: boolean;
  /** 0 for an opening, 1 for the one permitted follow-up. "never chained beyond a single follow-up." */
  readonly followUpDepth: number;
  /** The user's comfort setting (2.4). `minimal` means ambient only, with no spontaneous speech. */
  readonly setting: InitiativeSetting;
  /** The highest tier any option on the proposed turn would carry. */
  readonly maxTier: ConsequenceTier;
  /** Escape hatch for the experiment that 5.5's RISK entry calls for. Defaults to the MVP cut. */
  readonly spontaneousEnabled?: boolean;
}

/** A closed set, so a test can enumerate every way the Companion can be told to stay quiet. */
export type InitiativeRefusal =
  | 'setting.off'
  | 'setting.minimal'
  | 'mvp.spontaneousDeferred'
  | 'session.warmup'
  | 'capture.forming'
  | 'user.moving'
  | 'subject.notPresent'
  | 'chain.followUpExhausted'
  | 'rate.perSession'
  | 'rate.perHour'
  | 'rate.cooldown'
  | 'tier.notOfferableByInitiative'
  | 'cooldown.notSure'
  | 'cooldown.skip'
  | 'signal.wrongQuestion'
  | 'thread.dismissed'
  | 'asked.thisSession';

/**
 * What the Companion is permitted to do when it wants to raise something.
 *
 * `modal` is typed as the literal `false`. 5.5: "The user never has to dismiss a modal, BECAUSE
 * THERE IS NEVER A MODAL." A field that can only hold one value is a strange field until you
 * notice that it makes the sentence unfalsifiable by a future caller.
 */
export interface InitiativeOffer {
  readonly allowed: true;
  /** "Before speaking, the Companion MATERIALIZES SILENTLY near the subject." */
  readonly materializeSilentlyFirst: true;
  readonly dissolveAfterMs: number;
  readonly modal: false;
  /** "Ignoring is a first-class response and costs zero input." */
  readonly ignoringIsAnAnswer: true;
}

export interface InitiativeRefused {
  readonly allowed: false;
  readonly reason: InitiativeRefusal;
}

export type InitiativeDecision = InitiativeOffer | InitiativeRefused;

const refuse = (reason: InitiativeRefusal): InitiativeRefused =>
  Object.freeze({ allowed: false, reason });

function recentSpeechCount(memory: CompanionMemory, nowMs: number, windowMs: number): number {
  let n = 0;
  for (const t of memory.spokeAtMs) if (nowMs - t < windowMs) n += 1;
  return n;
}

/**
 * May the Companion speak, unprompted, about this question, right now?
 *
 * Gates run cheapest-and-most-absolute first, so the reason a caller gets back is the most
 * fundamental one that applies. A user who has set initiative to `off` should be told that, not
 * told that the session is 40 seconds old.
 */
export function mayInitiate(
  ctx: InitiativeContext,
  memory: CompanionMemory,
  intent: Intent,
  entityId: EntityIdRef | null,
): InitiativeDecision {
  if (ctx.setting === 'off') return refuse('setting.off');
  // "minimal means ambient only with no spontaneous speech at all."
  if (ctx.setting === 'minimal') return refuse('setting.minimal');

  const enabled = ctx.spontaneousEnabled ?? SPONTANEOUS_INITIATIVE_IN_MVP;
  if (!enabled) return refuse('mvp.spontaneousDeferred');

  // "never for a tier 3 operation" - and the Companion may never propose a deletion at all (5.3).
  if (!tierPolicy(ctx.maxTier).offerableByInitiative) {
    return refuse('tier.notOfferableByInitiative');
  }

  if (ctx.nowMs - ctx.sessionStartMs < SESSION_WARMUP_MS) return refuse('session.warmup');
  if (ctx.captureForming) return refuse('capture.forming');
  if (ctx.userMoving) return refuse('user.moving');
  if (!ctx.subjectPresent) return refuse('subject.notPresent');
  if (ctx.followUpDepth > 1) return refuse('chain.followUpExhausted');

  const suppression = hardSuppression(memory, intent, entityId, ctx.nowMs);
  if (suppression !== null) return refuse(suppression);

  if (memory.spokeAtMs.length >= MAX_SPEECH_PER_SESSION) return refuse('rate.perSession');
  if (recentSpeechCount(memory, ctx.nowMs, HOUR_MS) >= MAX_SPEECH_PER_HOUR) {
    return refuse('rate.perHour');
  }

  const last = memory.spokeAtMs[memory.spokeAtMs.length - 1];
  if (last !== undefined) {
    const cooldown = BASE_INITIATIVE_COOLDOWN_MS * memory.initiativeCooldownMultiplier;
    if (ctx.nowMs - last < cooldown) return refuse('rate.cooldown');
  }

  return Object.freeze({
    allowed: true,
    materializeSilentlyFirst: true,
    dissolveAfterMs: OFFER_DISSOLVE_MS,
    modal: false,
    ignoringIsAnAnswer: true,
  });
}

/**
 * THE AMBIENT CHANNEL. Always on, never gated, and it carries NO TEXT.
 *
 * 5.5: "an unresolved entity's anchor swaps its breathing for a slower, cooler pulse and its
 * ground ring becomes dashed. No text."
 *
 * This is a state name, not a shader. The renderer binding maps it to the pulse and the ring;
 * routing it through here is what keeps the visual driven by real semantic state rather than by
 * a material that was told to look mysterious.
 */
export type AmbientAnchorState = 'settled' | 'unresolved';

export function ambientAnchorState(resolved: boolean): AmbientAnchorState {
  return resolved ? 'settled' : 'unresolved';
}

/**
 * The persistent HUD counter's rendering contract (5.5).
 *
 * "It never grows a badge, never animates, never pops, never changes colour. It is allowed to
 * read 7 forever. THERE IS NO COMPLETION METRIC ANYWHERE IN THE PRODUCT."
 *
 * The type is the enforcement: there is no total, no percentage and no delta here, so a HUD
 * component cannot render a progress ring out of it however much it would like to.
 */
export interface OpenQuestionIndicator {
  readonly count: number;
  readonly labelKey: 'hud.openQuestions';
  readonly animates: false;
  readonly badge: false;
  readonly opensReviewQueue: true;
}

export function openQuestionIndicator(count: number): OpenQuestionIndicator {
  return Object.freeze({
    count,
    labelKey: 'hud.openQuestions',
    animates: false,
    badge: false,
    opensReviewQueue: true,
  });
}

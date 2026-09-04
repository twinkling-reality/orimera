import type { EntityIdRef } from '@exulanica/graph-client';
import type { Intent } from './intent.js';
import type { EscapeKind } from './turn.js';

/**
 * CONVERSATION MEMORY: what the user has already told the Companion to leave alone.
 *
 * The escape table in interaction-model.md 4.3 assigns each escape a lasting effect, and 5.5
 * makes two of those effects hard gates on spontaneous speech. Both readings live here so that
 * "never within 7 days of a Skip or 14 days of a Not sure on the same entity" is one function
 * with a test rather than a condition copied into two call sites.
 *
 * Two strengths of suppression, deliberately distinct:
 *
 *   HARD  - the question may not be asked at all. Skip, Not sure, and "that is the wrong
 *           question" all produce this for their window.
 *   SOFT  - the question may be asked but ranks lower. 4.3 says Not sure "LOWERS RE-ASK PRIORITY
 *           on this entity for 14 days", which is a ranking statement, while 5.5 says initiative
 *           may never speak within 14 days of one, which is a gate. Both are true of different
 *           channels: the user opening the review queue themselves is not the Companion speaking.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 4.3 and 5.5: "never within ... 14 days of a Not sure on the same entity". */
export const NOT_SURE_COOLDOWN_MS = 14 * DAY_MS;
/** 4.3 and 5.5: "never within 7 days of a Skip". */
export const SKIP_COOLDOWN_MS = 7 * DAY_MS;

export interface TranscriptEntry {
  readonly turnId: string;
  readonly intent: Intent;
  readonly subjectEntityId: EntityIdRef | null;
  readonly optionId: string | null;
  readonly escape: EscapeKind | null;
  /** Verbatim, when the user typed. Never paraphrased (5.1). */
  readonly rawUtterance: string | null;
  readonly atMs: number;
  readonly stateVersion: number;
}

/** `${intent}|${entityId}` - a question is a pair, not just a subject. */
export type QuestionKey = string;

export function questionKey(intent: Intent, entityId: EntityIdRef | null): QuestionKey {
  return `${intent}|${entityId ?? '-'}`;
}

export interface CompanionMemory {
  /** Entity -> instant the Not sure window expires. */
  readonly notSureUntilMs: ReadonlyMap<EntityIdRef, number>;
  /** Entity -> instant the Skip window expires. */
  readonly skipUntilMs: ReadonlyMap<EntityIdRef, number>;
  /**
   * 4.3: a Skip means "initiative cooldown DOUBLES". Multiplicative and unbounded on purpose:
   * a user who skips six times in a row has said something, and the sixth skip should cost the
   * Companion more than the first did.
   */
  readonly initiativeCooldownMultiplier: number;
  /**
   * "That is the wrong question": a negative signal on (intent, entity). "The only channel by
   * which a user can tell the system its framing is off." It does not expire on a timer, because
   * a wrong framing does not become right after a fortnight.
   */
  readonly wrongQuestion: ReadonlySet<QuestionKey>;
  /** Threads closed with Later. No penalty, but not re-opened unprompted in the same session. */
  readonly dismissed: ReadonlySet<QuestionKey>;
  /** Asked at least once this session. Stops the generator looping on one question. */
  readonly askedThisSession: ReadonlySet<QuestionKey>;
  /** Instants at which the Companion spoke spontaneously. Feeds the per-session and per-hour caps. */
  readonly spokeAtMs: readonly number[];
  readonly transcript: readonly TranscriptEntry[];
}

export const EMPTY_MEMORY: CompanionMemory = Object.freeze({
  notSureUntilMs: new Map<EntityIdRef, number>(),
  skipUntilMs: new Map<EntityIdRef, number>(),
  initiativeCooldownMultiplier: 1,
  wrongQuestion: new Set<QuestionKey>(),
  dismissed: new Set<QuestionKey>(),
  askedThisSession: new Set<QuestionKey>(),
  spokeAtMs: Object.freeze([]),
  transcript: Object.freeze([]),
});

function withMapEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function withSetEntry<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  next.add(value);
  return next;
}

export interface EscapeRecord {
  readonly escape: EscapeKind;
  readonly intent: Intent;
  readonly entityId: EntityIdRef | null;
  readonly atMs: number;
}

/**
 * Apply an escape's lasting effect. Pure: returns new memory.
 *
 * `later` deliberately changes nothing except the dismissed set. 4.3: "Closes the thread, NO
 * PENALTY." A user who is busy is not a user who is uninterested, and the single most common way
 * to make an assistant feel punitive is to treat "not now" as "not ever".
 */
export function recordEscape(memory: CompanionMemory, record: EscapeRecord): CompanionMemory {
  const key = questionKey(record.intent, record.entityId);
  const base = { ...memory, dismissed: memory.dismissed, askedThisSession: memory.askedThisSession };

  switch (record.escape) {
    case 'not_sure':
      return Object.freeze({
        ...base,
        notSureUntilMs:
          record.entityId === null
            ? memory.notSureUntilMs
            : withMapEntry(memory.notSureUntilMs, record.entityId, record.atMs + NOT_SURE_COOLDOWN_MS),
        dismissed: withSetEntry(memory.dismissed, key),
      });
    case 'skip':
      return Object.freeze({
        ...base,
        skipUntilMs:
          record.entityId === null
            ? memory.skipUntilMs
            : withMapEntry(memory.skipUntilMs, record.entityId, record.atMs + SKIP_COOLDOWN_MS),
        initiativeCooldownMultiplier: memory.initiativeCooldownMultiplier * 2,
        dismissed: withSetEntry(memory.dismissed, key),
      });
    case 'later':
      return Object.freeze({ ...base, dismissed: withSetEntry(memory.dismissed, key) });
    case 'wrong_question':
      return Object.freeze({
        ...base,
        wrongQuestion: withSetEntry(memory.wrongQuestion, key),
        dismissed: withSetEntry(memory.dismissed, key),
      });
  }
}

export function recordAsked(
  memory: CompanionMemory,
  intent: Intent,
  entityId: EntityIdRef | null,
): CompanionMemory {
  return Object.freeze({
    ...memory,
    askedThisSession: withSetEntry(memory.askedThisSession, questionKey(intent, entityId)),
  });
}

export function recordTranscript(
  memory: CompanionMemory,
  entry: TranscriptEntry,
): CompanionMemory {
  return Object.freeze({ ...memory, transcript: Object.freeze([...memory.transcript, entry]) });
}

/** The Companion opened its mouth without being asked. Feeds the per-session and per-hour caps. */
export function recordSpontaneousSpeech(memory: CompanionMemory, atMs: number): CompanionMemory {
  return Object.freeze({ ...memory, spokeAtMs: Object.freeze([...memory.spokeAtMs, atMs]) });
}

export type SuppressionReason =
  | 'cooldown.notSure'
  | 'cooldown.skip'
  | 'signal.wrongQuestion'
  | 'thread.dismissed'
  | 'asked.thisSession';

/**
 * Why this question may not be asked right now, or null if it may.
 *
 * A closed reason set rather than a boolean, because every one of these reasons is something the
 * runtime may need to say out loud: "unavailable with a reason" is the Yarn Spinner availability
 * semantics the option pool uses (4.4 stage 3), and a bare false cannot fill that in.
 */
export function hardSuppression(
  memory: CompanionMemory,
  intent: Intent,
  entityId: EntityIdRef | null,
  nowMs: number,
): SuppressionReason | null {
  const key = questionKey(intent, entityId);
  if (memory.wrongQuestion.has(key)) return 'signal.wrongQuestion';
  if (entityId !== null) {
    const notSure = memory.notSureUntilMs.get(entityId);
    if (notSure !== undefined && nowMs < notSure) return 'cooldown.notSure';
    const skip = memory.skipUntilMs.get(entityId);
    if (skip !== undefined && nowMs < skip) return 'cooldown.skip';
  }
  if (memory.dismissed.has(key)) return 'thread.dismissed';
  if (memory.askedThisSession.has(key)) return 'asked.thisSession';
  return null;
}

/**
 * Ranking penalty, 0..1, multiplied into the value function.
 *
 * This is the SOFT reading of 4.3's "lowers re-ask priority": the entity still appears in the
 * review queue and the user can still open it, it simply stops being the thing the system
 * volunteers first. A hard block here would hide the user's own data from the user, which is a
 * different and much worse failure than asking a question twice.
 */
export function priorityPenalty(
  memory: CompanionMemory,
  entityId: EntityIdRef | null,
  nowMs: number,
): number {
  if (entityId === null) return 1;
  let penalty = 1;
  const notSure = memory.notSureUntilMs.get(entityId);
  if (notSure !== undefined && nowMs < notSure) penalty *= 0.25;
  const skip = memory.skipUntilMs.get(entityId);
  if (skip !== undefined && nowMs < skip) penalty *= 0.5;
  return penalty;
}

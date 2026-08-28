import { describe, expect, it } from 'vitest';
import { openQuestionCount } from '@orimera/graph-client';
import {
  BASE_INITIATIVE_COOLDOWN_MS,
  EMPTY_MEMORY,
  HOUR_MS,
  MAX_SPEECH_PER_SESSION,
  SESSION_WARMUP_MS,
  SNAPSHOT_T1,
  SPONTANEOUS_INITIATIVE_IN_MVP,
  ambientAnchorState,
  mayInitiate,
  openQuestionIndicator,
  recordEscape,
  recordSpontaneousSpeech,
} from '../src/index.js';
import type { CompanionMemory, InitiativeContext, InitiativeRefusal } from '../src/index.js';

const START = Date.UTC(2026, 7, 27, 9, 0, 0);

/** A context in which every gate passes, so each test can fail exactly one of them. */
const permissive = (overrides: Partial<InitiativeContext> = {}): InitiativeContext => ({
  nowMs: START + SESSION_WARMUP_MS + 1_000,
  sessionStartMs: START,
  userMoving: false,
  captureForming: false,
  subjectPresent: true,
  followUpDepth: 0,
  setting: 'normal',
  maxTier: 1,
  spontaneousEnabled: true,
  ...overrides,
});

const reasonFor = (
  ctx: Partial<InitiativeContext>,
  memory: CompanionMemory = EMPTY_MEMORY,
): InitiativeRefusal | 'allowed' => {
  const decision = mayInitiate(permissive(ctx), memory, 'resolve_identity', 'ent-julie');
  return decision.allowed ? 'allowed' : decision.reason;
};

describe('the initiative gate never turns exploration into a questionnaire', () => {
  it('is off in the MVP unless a caller deliberately enables it', () => {
    expect(SPONTANEOUS_INITIATIVE_IN_MVP).toBe(false);
    const decision = mayInitiate(
      { ...permissive(), spontaneousEnabled: undefined },
      EMPTY_MEMORY,
      'resolve_identity',
      'ent-julie',
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('mvp.spontaneousDeferred');
  });

  it('honours the comfort setting before anything else', () => {
    expect(reasonFor({ setting: 'off' })).toBe('setting.off');
    // "minimal means ambient only with no spontaneous speech at all."
    expect(reasonFor({ setting: 'minimal' })).toBe('setting.minimal');
  });

  it('enforces each hard gate from 5.5 independently', () => {
    expect(reasonFor({ nowMs: START + SESSION_WARMUP_MS - 1 })).toBe('session.warmup');
    expect(reasonFor({ captureForming: true })).toBe('capture.forming');
    expect(reasonFor({ userMoving: true })).toBe('user.moving');
    expect(reasonFor({ subjectPresent: false })).toBe('subject.notPresent');
    expect(reasonFor({ followUpDepth: 2 })).toBe('chain.followUpExhausted');
    expect(reasonFor({ maxTier: 3 })).toBe('tier.notOfferableByInitiative');
    expect(reasonFor({})).toBe('allowed');
  });

  it('never speaks within 7 days of a Skip or 14 days of a Not sure on the same entity', () => {
    const day = 24 * 60 * 60 * 1000;
    const skipped = recordEscape(EMPTY_MEMORY, {
      escape: 'skip',
      intent: 'resolve_identity',
      entityId: 'ent-julie',
      atMs: START,
    });
    expect(reasonFor({ nowMs: START + 6 * day }, skipped)).toBe('cooldown.skip');

    const unsure = recordEscape(EMPTY_MEMORY, {
      escape: 'not_sure',
      intent: 'resolve_identity',
      entityId: 'ent-julie',
      atMs: START,
    });
    expect(reasonFor({ nowMs: START + 13 * day }, unsure)).toBe('cooldown.notSure');
  });

  it('takes "that is the wrong question" as a lasting signal on the pair', () => {
    const wrong = recordEscape(EMPTY_MEMORY, {
      escape: 'wrong_question',
      intent: 'resolve_identity',
      entityId: 'ent-julie',
      atMs: START,
    });
    const farFuture = START + 365 * 24 * 60 * 60 * 1000;
    expect(reasonFor({ nowMs: farFuture }, wrong)).toBe('signal.wrongQuestion');
  });

  it('doubles the cooldown after a Skip', () => {
    const base = recordSpontaneousSpeech(EMPTY_MEMORY, START);
    const justInside = START + BASE_INITIATIVE_COOLDOWN_MS + 1;
    expect(reasonFor({ nowMs: justInside }, base)).toBe('allowed');

    // A Skip on some other entity still doubles the global initiative cooldown (4.3).
    const skipped = recordSpontaneousSpeech(
      recordEscape(EMPTY_MEMORY, {
        escape: 'skip',
        intent: 'resolve_identity',
        entityId: 'ent-mira',
        atMs: START,
      }),
      START,
    );
    expect(skipped.initiativeCooldownMultiplier).toBe(2);
    expect(reasonFor({ nowMs: justInside }, skipped)).toBe('rate.cooldown');
  });

  it('caps how often it speaks per session and per hour', () => {
    let memory = EMPTY_MEMORY;
    for (let i = 0; i < MAX_SPEECH_PER_SESSION; i += 1) {
      memory = recordSpontaneousSpeech(memory, START - (i + 1) * HOUR_MS * 2);
    }
    expect(reasonFor({}, memory)).toBe('rate.perSession');
  });

  it('materializes silently, dissolves if ignored, and is never a modal', () => {
    const decision = mayInitiate(permissive(), EMPTY_MEMORY, 'resolve_identity', 'ent-julie');
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.materializeSilentlyFirst).toBe(true);
    expect(decision.modal).toBe(false);
    expect(decision.ignoringIsAnAnswer).toBe(true);
    expect(decision.dissolveAfterMs).toBeGreaterThan(0);
  });
});

describe('the ambient channel is always on and carries no text', () => {
  it('names a state rather than describing a shader', () => {
    expect(ambientAnchorState(false)).toBe('unresolved');
    expect(ambientAnchorState(true)).toBe('settled');
  });

  it('exposes a count and no completion metric anywhere', () => {
    const indicator = openQuestionIndicator(openQuestionCount(SNAPSHOT_T1));
    expect(indicator.count).toBeGreaterThan(0);
    expect(indicator.animates).toBe(false);
    expect(indicator.badge).toBe(false);
    // There is no total, no percentage and no "resolved so far" to build a progress ring from.
    expect(Object.keys(indicator).sort()).toEqual([
      'animates',
      'badge',
      'count',
      'labelKey',
      'opensReviewQueue',
    ]);
  });
});

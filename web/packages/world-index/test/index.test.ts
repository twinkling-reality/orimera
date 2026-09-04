import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@exulanica/graph-client';
import {
  BAND_ORDER,
  MOCK_NOW_MS,
  SNAPSHOT_T3,
  TierPolicyError,
  buildConfirmation,
  draftFromParse,
  parseUtterance,
  sequentialIds,
} from '@exulanica/companion-runtime';
import {
  ACTION_TIER,
  ALL_FACETS,
  DETAIL_SECTION_ORDER,
  MIN_TOUCH_TARGET_PX,
  REVIEW_QUEUE_FACETS,
  VIRTUAL_JOYSTICK_SUPPORTED,
  applyFacets,
  assertBatchAllowed,
  availableActions,
  batchableActions,
  buildEntityDetail,
  buildIndexView,
  decodeFacets,
  encodeFacets,
  entrySurface,
  isReviewQueue,
  parseSearch,
  reviewQueue,
  toRow,
  travelTo,
} from '../src/index.js';

const entity = (id: string): EntityRecord => {
  const found = SNAPSHOT_T3.entities.find((e) => e.entityId === id);
  if (found === undefined) throw new Error(`fixture lost ${id}`);
  return found;
};

describe('the searchable inventory', () => {
  it('lists every entity under no facets', () => {
    const view = buildIndexView({ snapshot: SNAPSHOT_T3, nowMs: MOCK_NOW_MS });
    expect(view.rows.length).toBe(SNAPSHOT_T3.entities.length);
    expect(view.emptyStateKey).toBeNull();
  });

  it('filters on each of the four facets', () => {
    const people = applyFacets(SNAPSHOT_T3.entities, { ...ALL_FACETS, kinds: ['person'] });
    expect(people.map((e) => e.entityId).sort()).toEqual(['ent-ghost', 'ent-julie', 'ent-mira']);

    const inHarbour = applyFacets(SNAPSHOT_T3.entities, {
      ...ALL_FACETS,
      islands: ['isl-harbour-2021'],
    });
    expect(inHarbour.map((e) => e.entityId).sort()).toEqual([
      'ent-bike',
      'ent-harbour',
      'ent-julie',
    ]);

    const external = applyFacets(SNAPSHOT_T3.entities, { ...ALL_FACETS, sources: ['external'] });
    expect(external.map((e) => e.entityId)).toEqual(['ent-harbour']);

    const review = applyFacets(SNAPSHOT_T3.entities, REVIEW_QUEUE_FACETS);
    expect(review.map((e) => e.entityId)).toEqual(['ent-bike']);
  });

  it('round-trips a filtered state through a URL', () => {
    const facets = {
      ...ALL_FACETS,
      kinds: ['person' as const],
      sources: ['user' as const, 'inference' as const],
      text: 'harbour',
    };
    const query = encodeFacets(facets);
    const decoded = decodeFacets(query);
    expect(decoded.kinds).toEqual(['person']);
    expect(decoded.sources.sort()).toEqual(['inference', 'user']);
    expect(decoded.text).toBe('harbour');
    // Stable: the same filter always encodes to the same string.
    expect(encodeFacets(decoded)).toBe(query);
  });

  it('drops unknown values from a stale URL instead of erroring', () => {
    const decoded = decodeFacets('kind=person,unicorn&status=nonsense');
    expect(decoded.kinds).toEqual(['person']);
    expect(decoded.statuses).toEqual([]);
  });

  it('peels prefix operators off and falls through to semantic search', () => {
    const parsed = parseSearch('kind:person status:needs-review who was at the harbour');
    expect(parsed.facets.kinds).toEqual(['person']);
    expect(parsed.facets.statuses).toEqual(['needs_review']);
    expect(parsed.text).toBe('who was at the harbour');

    const view = buildIndexView({
      snapshot: SNAPSHOT_T3,
      search: 'kind:person who was at the harbour',
      nowMs: MOCK_NOW_MS,
    });
    expect(view.semantic?.text).toBe('who was at the harbour');
    // ANN is recall and ranking only, never set membership.
    expect(view.semantic?.usedForSetMembership).toBe(false);
  });

  it('reports an operator it does not know rather than swallowing it', () => {
    const parsed = parseSearch('colour:green Julie');
    expect(parsed.unknownOperators).toEqual(['colour:green']);
  });
});

describe('a row makes the four kinds of knowledge visually distinguishable', () => {
  it('uses an honest placeholder instead of inventing a name', () => {
    const row = toRow(entity('ent-ghost'));
    expect(row.displayName).toBeNull();
    expect(row.placeholder).toEqual({
      key: 'placeholder.unnamed',
      kind: 'person',
      occurrenceCount: 1,
    });
  });

  it('keeps the triad and the external badge as separate marks', () => {
    const julie = toRow(entity('ent-julie'));
    expect(julie.triad).toEqual({ user: true, capture: true, inference: true });
    expect(julie.external).toBeNull();

    const harbour = toRow(entity('ent-harbour'));
    expect(harbour.triad.user).toBe(true);
    expect(harbour.external?.barredFromHistoricalClaims).toBe(true);
    expect(harbour.external?.latestRetrievedAtMs).toBeGreaterThan(0);
  });

  it('shows a confidence bar only where the system is still guessing', () => {
    // Julie is user-asserted, so the detector's confidence stops being the headline.
    expect(toRow(entity('ent-julie')).confidence).toBeNull();
    const t1Julie = { ...entity('ent-julie'), displayName: null, assertions: entity('ent-julie').assertions.filter((a) => a.kind !== 'user') };
    expect(toRow(t1Julie).confidence).toBe('medium');
  });
});

describe('entity detail is one fixed order and one provenance component', () => {
  it('keeps the documented section order', () => {
    const detail = buildEntityDetail({ snapshot: SNAPSHOT_T3, entity: entity('ent-julie') });
    expect(detail.sections).toEqual([
      'identity',
      'provenance',
      'occurrences',
      'relations',
      'history',
    ]);
    expect(DETAIL_SECTION_ORDER).toEqual(detail.sections);
  });

  it('renders the same four bands the dialogue panel renders', () => {
    const subject = entity('ent-julie');
    const detail = buildEntityDetail({ snapshot: SNAPSHOT_T3, entity: subject });
    expect(detail.provenance.bands.map((b) => b.band)).toEqual([...BAND_ORDER]);

    const draft = draftFromParse(parseUtterance('That is Julie, a friend'), {
      ids: sequentialIds(),
      subjectEntityId: subject.entityId,
      anchorIds: [],
      islandIds: [],
      captureEvidence: [],
    });
    if (draft === null) throw new Error('expected a draft');
    const dialogue = buildConfirmation({ draft, entity: subject, surface: 'dialogue' });

    // Bands 2, 3 and 4 are identical between the two mount points: it is one builder.
    expect(JSON.stringify(dialogue.bands.slice(1))).toBe(
      JSON.stringify(
        buildEntityDetail({
          snapshot: SNAPSHOT_T3,
          entity: subject,
          pendingDraft: draft,
        }).provenance.bands.slice(1),
      ),
    );
  });

  it('lists occurrences chronologically and says when a time is unknown', () => {
    const detail = buildEntityDetail({ snapshot: SNAPSHOT_T3, entity: entity('ent-julie') });
    const times = detail.occurrences.map((o) => o.capturedAtMs ?? Number.POSITIVE_INFINITY);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(detail.occurrences.every((o) => o.evidence.length > 0)).toBe(true);
    expect(detail.occurrences.some((o) => o.timeUnknown)).toBe(false);
  });
});

describe('actions carry consequence-appropriate confirmation', () => {
  it('assigns the documented tiers', () => {
    expect(ACTION_TIER).toEqual({
      locate: 0,
      inspect: 0,
      edit: 1,
      review: 0,
      merge: 2,
      split: 2,
      delete: 3,
    });
  });

  it('offers delete only from the index, and never from the dialogue panel', () => {
    const fromIndex = availableActions(entity('ent-julie'), 'world_index');
    expect(fromIndex.map((a) => a.action)).toContain('delete');

    const fromDialogue = availableActions(entity('ent-julie'), 'dialogue');
    expect(fromDialogue.map((a) => a.action)).not.toContain('delete');
  });

  it('states what delete would have to show, and that it is out of the MVP cut', () => {
    const del = availableActions(entity('ent-julie')).find((a) => a.action === 'delete');
    expect(del?.available).toBe(false);
    expect(del?.unavailableReasonKey).toBe('unavailable.outOfMvpCut');
    expect(del?.policy.requiresTypedDisplayName).toBe(true);
    expect(del?.policy.requiresMediaRetentionStatement).toBe(true);
    expect(del?.policy.requiresCitationLossCount).toBe(true);
  });

  it('requires a blast radius and a live preview for merge and split', () => {
    for (const action of ['merge', 'split'] as const) {
      const offer = availableActions(entity('ent-julie')).find((a) => a.action === action);
      expect(offer?.policy.requiresBlastRadius).toBe(true);
      expect(offer?.policy.requiresLivePreview).toBe(true);
      expect(offer?.policy.controls).toBe('cancel_and_confirm');
    }
  });

  it('permits batch operations at tier 1 only', () => {
    expect(batchableActions()).toEqual(['locate', 'inspect', 'review', 'edit']);
    expect(() => assertBatchAllowed('edit')).not.toThrow();
    expect(() => assertBatchAllowed('merge')).toThrow(TierPolicyError);
    expect(() => assertBatchAllowed('delete')).toThrow(TierPolicyError);
  });

  it('does not offer split on an entity with a single occurrence', () => {
    const offer = availableActions(entity('ent-mira')).find((a) => a.action === 'split');
    expect(offer?.available).toBe(false);
    expect(offer?.unavailableReasonKey).toBe('unavailable.nothingToSplit');
  });
});

describe('the review queue is a filtered state of the index, not a screen', () => {
  it('is recognisable as a facet preset', () => {
    expect(isReviewQueue(REVIEW_QUEUE_FACETS)).toBe(true);
    expect(isReviewQueue(ALL_FACETS)).toBe(false);
    const view = buildIndexView({ snapshot: SNAPSHOT_T3, facets: REVIEW_QUEUE_FACETS });
    expect(view.isReviewQueue).toBe(true);
  });

  it('produces the same rows as the browse path for the same entity', () => {
    const queue = reviewQueue(SNAPSHOT_T3, undefined, MOCK_NOW_MS);
    const browse = buildIndexView({ snapshot: SNAPSHOT_T3, nowMs: MOCK_NOW_MS });
    for (const row of queue.rows) {
      const same = browse.rows.find((r) => r.entityId === row.entityId);
      expect(same).toEqual(row);
    }
  });

  it('exposes no completion metric of any kind', () => {
    const queue = reviewQueue(SNAPSHOT_T3);
    expect(Object.keys(queue).sort()).toEqual([
      'defaultAction',
      'emptyStateKey',
      'facets',
      'rows',
    ]);
    expect(queue.emptyStateKey).toBe('review.nothingNeedsAttention');
    expect(queue.defaultAction).toBe('review');
  });

  it('orders by the same value function the Companion uses', () => {
    const bike = entity('ent-bike');
    const julie = entity('ent-julie');
    const snapshot = {
      ...SNAPSHOT_T3,
      entities: [julie, bike].map((e) => ({ ...e, status: 'needs_review' as const })),
    };
    const queue = reviewQueue(snapshot, undefined, MOCK_NOW_MS);
    // Julie spans two regions and carries more open questions; the bike carries a contradiction.
    expect(queue.rows.length).toBe(2);
    expect(new Set(queue.rows.map((r) => r.entityId))).toEqual(
      new Set(['ent-julie', 'ent-bike']),
    );
  });
});

describe('mobile is the default entry, not an afterthought', () => {
  it('sends a device without pointer lock to the index', () => {
    expect(entrySurface({ pointerLockSupported: false, touch: true })).toBe('world-index');
    expect(entrySurface({ pointerLockSupported: false, touch: false })).toBe('world-index');
    expect(entrySurface({ pointerLockSupported: true, touch: true })).toBe('world-index');
    expect(entrySurface({ pointerLockSupported: true, touch: false })).toBe('atlas');
  });

  it('asks for a vantage pose and never for an anchor position', () => {
    const request = travelTo(SNAPSHOT_T3, entity('ent-julie'), 'tap_to_travel', false);
    expect(request?.target).toBe('vantage_pose');
    expect(request?.interruptibleByAnyTouch).toBe(true);
    expect(Object.keys(request ?? {})).not.toContain('position');
  });

  it('returns null when there is nowhere to travel to', () => {
    const orphan = { ...entity('ent-julie'), entityId: 'ent-nobody' };
    expect(travelTo(SNAPSHOT_T3, orphan, 'locate', false)).toBeNull();
  });

  it('has no virtual joystick and a 44px touch target floor', () => {
    expect(VIRTUAL_JOYSTICK_SUPPORTED).toBe(false);
    expect(MIN_TOUCH_TARGET_PX).toBe(44);
  });
});

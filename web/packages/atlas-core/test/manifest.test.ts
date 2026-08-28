import { describe, expect, it } from 'vitest';
import type { EmphasisLevel, ViewManifest } from '../src/index.js';
import {
  EMPTY_MANIFEST_STATE,
  EMPHASIS_SCALAR,
  MAX_CAPTIONS,
  ManifestValidationError,
  anchorId,
  applyViewManifest,
  applyViewManifestInto,
  allocateEmphasisBuffers,
  buildAnchorTable,
  buildConjunctionManifest,
  buildDisjunctionManifest,
  buildEntityManifest,
  buildPreviewManifest,
  clearPreview,
  entityId,
  islandId,
  manifestId,
  popManifest,
  pushManifest,
  resolveActive,
  setPreview,
  staleManifests,
} from '../src/index.js';
import { deepFreeze, island, scene, snapshot } from './fixture.js';

const world = scene([
  island({
    key: 'i1',
    createdAt: 1,
    position: [0, 0, 0],
    anchors: [
      { key: 'a', local: [0, 1, -3], entity: 'alice' },
      { key: 'b', local: [2, 1, -4], entity: 'bob' },
      { key: 'c', local: [-2, 1, -5], entity: null },
    ],
  }),
  island({
    key: 'i2',
    createdAt: 2,
    position: [300, 0, 40],
    anchors: [
      { key: 'a', local: [0, 1, -3], entity: 'alice' },
      { key: 'd', local: [1, 1, -6], entity: 'dana' },
    ],
  }),
]);

const identity = {
  manifestId: manifestId('m1'),
  createdAt: 0,
  stateVersion: 1,
  reducedMotion: false,
};

const entityResult = (id: string, anchors: readonly string[], islands: readonly string[]) => ({
  entityId: entityId(id),
  anchors: anchors.map(anchorId),
  coOccurring: [],
  islands: islands.map(islandId),
  occurrenceCount: anchors.length,
  evidence: [],
});

describe('applying a view manifest is non-destructive', () => {
  it('does not touch the scene, the anchor table or the manifest', () => {
    const frozen = deepFreeze(world);
    const table = buildAnchorTable(frozen);
    const manifest = buildEntityManifest(
      identity,
      table,
      entityResult('alice', ['i1/a', 'i2/a'], ['i1', 'i2']),
    );

    const sceneBefore = snapshot(frozen);
    const manifestBefore = snapshot(manifest);
    const positionsBefore = Array.from(table.atlasPositions);

    applyViewManifest(table, manifest, frozen.stateVersion);
    applyViewManifest(table, manifest, frozen.stateVersion);

    expect(snapshot(frozen)).toBe(sceneBefore);
    expect(snapshot(manifest)).toBe(manifestBefore);
    expect(Array.from(table.atlasPositions)).toEqual(positionsBefore);
  });

  it('cannot express a position or a camera, so a query can never move the world', () => {
    // Anti-disorientation rules 2 and 3 are structural. If a field were ever added that could
    // carry a placement or a camera pose, this test is the one that should be deleted last.
    const manifest = buildEntityManifest(identity, buildAnchorTable(world), entityResult('alice', ['i1/a'], ['i1']));
    const keys = Object.keys(manifest);
    expect(keys).toEqual([
      'manifestId',
      'createdAt',
      'stateVersion',
      'query',
      'emphasis',
      'threads',
      'captions',
      'focusCandidates',
      'summary',
      'transition',
    ]);
  });

  it('gives identical buffers on repeated application', () => {
    const table = buildAnchorTable(world);
    const manifest = buildEntityManifest(identity, table, entityResult('alice', ['i1/a', 'i2/a'], ['i1', 'i2']));
    const a = applyViewManifest(table, manifest, 1);
    const b = applyViewManifest(table, manifest, 1);
    expect(Array.from(a.anchorEmphasis)).toEqual(Array.from(b.anchorEmphasis));
    expect(Array.from(a.anchorLevel)).toEqual(Array.from(b.anchorLevel));
  });

  it('reuses caller-owned buffers on the hover path without allocating', () => {
    const table = buildAnchorTable(world);
    const buffers = allocateEmphasisBuffers(table);
    const manifest = buildEntityManifest(identity, table, entityResult('alice', ['i1/a'], ['i1']));
    const frame = applyViewManifestInto(table, manifest, buffers, 1);
    expect(frame.anchorEmphasis).toBe(buffers.anchorEmphasis);
    expect(frame.anchorLevel).toBe(buffers.anchorLevel);
  });

  it('writes primary for the subject, muted for everything else, and never hidden', () => {
    const table = buildAnchorTable(world);
    const manifest = buildEntityManifest(identity, table, entityResult('alice', ['i1/a', 'i2/a'], ['i1', 'i2']));
    const frame = applyViewManifest(table, manifest, 1);
    // Float32 storage, so compare with tolerance rather than identity.
    const at = (id: string) => frame.anchorEmphasis[table.indexOf.get(anchorId(id))!]!;
    expect(at('i1/a')).toBeCloseTo(EMPHASIS_SCALAR.primary, 6);
    expect(at('i2/a')).toBeCloseTo(EMPHASIS_SCALAR.primary, 6);
    expect(at('i1/b')).toBeCloseTo(EMPHASIS_SCALAR.muted, 6);
    expect(Array.from(frame.anchorEmphasis).every((v) => v > 0)).toBe(true);
    expect(Array.from(frame.anchorInteractable).every((v) => v === 1)).toBe(true);
  });
});

describe('the anti-disorientation rules that need a runtime check', () => {
  const table = buildAnchorTable(world);
  const base = buildEntityManifest(identity, table, entityResult('alice', ['i1/a'], ['i1']));

  const withHidden = (kind: ViewManifest['query']['kind']): ViewManifest => ({
    ...base,
    query: { kind, entityIds: [] },
    emphasis: {
      ...base.emphasis,
      anchors: new Map<ReturnType<typeof anchorId>, EmphasisLevel>([[anchorId('i1/b'), 'hidden']]),
    },
  });

  it('refuses to hide anchors for a query result: mute, do not hide', () => {
    for (const kind of ['entity', 'conjunction', 'disjunction', 'temporal', 'natural-language', 'preview'] as const) {
      expect(() => applyViewManifest(table, withHidden(kind), 1)).toThrow(ManifestValidationError);
    }
  });

  it('permits hidden only for content the user deleted', () => {
    expect(() => applyViewManifest(table, withHidden('deleted-content'), 1)).not.toThrow();
    const frame = applyViewManifest(table, withHidden('deleted-content'), 1);
    const i = table.indexOf.get(anchorId('i1/b'))!;
    expect(frame.anchorEmphasis[i]).toBe(0);
    expect(frame.anchorInteractable[i]).toBe(0);
    expect(frame.anchorLabelable[i]).toBe(0);
  });

  it('refuses an instant transition with no summary, because the caption replaces the animation', () => {
    const silent: ViewManifest = {
      ...base,
      transition: { durationMs: 0, style: 'instant' },
      summary: { key: '', counts: [], evidence: [] },
    };
    expect(() => applyViewManifest(table, silent, 1)).toThrow(/reduced motion/);
  });

  it('accepts an instant transition that carries its caption', () => {
    const reduced = buildEntityManifest(
      { ...identity, reducedMotion: true },
      table,
      entityResult('alice', ['i1/a'], ['i1']),
    );
    expect(reduced.transition.style).toBe('instant');
    expect(reduced.summary.key).not.toBe('');
    expect(() => applyViewManifest(table, reduced, 1)).not.toThrow();
  });

  it('enforces the overlay caption cap', () => {
    const tooMany: ViewManifest = {
      ...base,
      captions: Array.from({ length: MAX_CAPTIONS + 1 }, () => ({
        anchor: anchorId('i1/a'),
        key: 'caption.x',
        evidence: [],
      })),
    };
    expect(() => applyViewManifest(table, tooMany, 1)).toThrow(/overlay cap/);
  });
});

describe('staleness and unresolved references are reported, not swallowed', () => {
  const table = buildAnchorTable(world);

  it('flags a manifest computed against an older graph version', () => {
    const manifest = buildEntityManifest(identity, table, entityResult('alice', ['i1/a'], ['i1']));
    expect(applyViewManifest(table, manifest, 1).stale).toBe(false);
    expect(applyViewManifest(table, manifest, 2).stale).toBe(true);
  });

  it('surfaces anchors and islands the scene no longer contains', () => {
    const manifest = buildEntityManifest(
      identity,
      table,
      entityResult('ghost', ['i1/a', 'i9/z'], ['i1', 'i9']),
    );
    const frame = applyViewManifest(table, manifest, 1);
    expect(frame.unresolvedAnchors).toEqual([anchorId('i9/z')]);
    expect(frame.unresolvedIslands).toEqual([islandId('i9')]);
  });
});

describe('AND and OR look different, not merely count differently', () => {
  const table = buildAnchorTable(world);

  it('draws solid identity threads for one entity across islands', () => {
    const m = buildEntityManifest(identity, table, entityResult('alice', ['i1/a', 'i2/a'], ['i1', 'i2']));
    expect(m.threads).toHaveLength(1);
    expect(m.threads[0]!.style).toBe('identity');
    expect(m.threads[0]!.dashed).toBe(false);
  });

  it('draws OR in two distinguishable hues with no secondary set', () => {
    const m = buildDisjunctionManifest(identity, table, {
      a: entityResult('alice', ['i1/a', 'i2/a'], ['i1', 'i2']),
      b: entityResult('bob', ['i1/b'], ['i1']),
    });
    expect(new Set(m.threads.map((t) => t.hue))).toEqual(new Set([0]));
    expect([...m.emphasis.anchors.values()].every((v) => v === 'primary')).toBe(true);
    expect(m.summary.counts.map((c) => c.key)).toEqual(['count.withA', 'count.withB']);
    expect(m.summary.counts.every((c) => c.swapTo !== null)).toBe(true);
  });

  it('draws AND with solid co-presence and dashed single presence', () => {
    const m = buildConjunctionManifest(identity, table, {
      a: entityId('alice'),
      b: entityId('bob'),
      bothPresent: [[anchorId('i1/a'), anchorId('i1/b')]],
      aOnly: [anchorId('i2/a')],
      bOnly: [],
      islands: [islandId('i1'), islandId('i2')],
      evidence: [],
    });
    const solid = m.threads.filter((t) => !t.dashed);
    expect(solid).toHaveLength(1);
    expect(solid[0]!.style).toBe('copresence');
    expect(m.emphasis.anchors.get(anchorId('i1/a'))).toBe('primary');
    expect(m.emphasis.anchors.get(anchorId('i2/a'))).toBe('secondary');
    expect(m.summary.counts.map((c) => [c.key, c.value])).toEqual([
      ['count.both', 1],
      ['count.aOnly', 1],
      ['count.bOnly', 0],
    ]);
  });

  it('draws an unconfirmed proposal preview as dashed candidates', () => {
    const m = buildPreviewManifest(identity, {
      entityIds: [entityId('alice')],
      affected: [anchorId('i1/a'), anchorId('i2/a')],
      wouldLink: [[anchorId('i1/a'), anchorId('i2/a')]],
      islands: [islandId('i1'), islandId('i2')],
    });
    expect(m.query.kind).toBe('preview');
    expect(m.threads.every((t) => t.dashed && t.style === 'candidate')).toBe(true);
    expect(m.summary.counts).toEqual([
      { key: 'count.anchors', value: 2, swapTo: null },
      { key: 'count.regions', value: 2, swapTo: null },
    ]);
  });
});

describe('the manifest stack is reversible and the preview is free', () => {
  const table = buildAnchorTable(world);
  const m1 = buildEntityManifest(identity, table, entityResult('alice', ['i1/a'], ['i1']));
  const m2 = buildEntityManifest(
    { ...identity, manifestId: manifestId('m2') },
    table,
    entityResult('bob', ['i1/b'], ['i1']),
  );

  it('pushes on refine and pops on Backspace', () => {
    let s = pushManifest(EMPTY_MANIFEST_STATE, m1);
    s = pushManifest(s, m2);
    expect(resolveActive(s)).toBe(m2);
    s = popManifest(s);
    expect(resolveActive(s)).toBe(m1);
    s = popManifest(s);
    expect(resolveActive(s)).toBeNull();
    expect(popManifest(s)).toBe(s);
  });

  it('lets the preview slot win, and restores exactly on clear', () => {
    const base = pushManifest(EMPTY_MANIFEST_STATE, m1);
    const previewing = setPreview(base, m2);
    expect(resolveActive(previewing)).toBe(m2);
    const cancelled = clearPreview(previewing);
    expect(resolveActive(cancelled)).toBe(m1);
    expect(snapshot(cancelled)).toBe(snapshot(base));
  });

  it('finds every manifest a graph change invalidated', () => {
    const s = setPreview(pushManifest(EMPTY_MANIFEST_STATE, m1), m2);
    expect(staleManifests(s, 1)).toEqual([]);
    expect(staleManifests(s, 2)).toHaveLength(2);
  });
});

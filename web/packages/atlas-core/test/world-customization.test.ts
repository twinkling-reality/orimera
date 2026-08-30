import { describe, expect, it } from 'vitest';
import {
  WorldCustomizationController,
  islandId,
  resolveWorldStyleVersion,
  type WorldAppearanceProposal,
  type WorldStyleCatalog,
} from '../src/index.js';

const catalog: WorldStyleCatalog = Object.freeze({
  defaultProfile: Object.freeze({ profileId: 'celestial-emulsion', profileVersion: 1 }),
  profiles: Object.freeze([
    Object.freeze({ profileId: 'celestial-emulsion', profileVersion: 1, displayName: 'Celestial Emulsion' }),
    Object.freeze({ profileId: 'survey-relief', profileVersion: 1, displayName: 'Survey Relief' }),
  ]),
});

const controller = () => new WorldCustomizationController({
  topologyDigest: 'topology-1',
  regionIds: new Set([islandId('a'), islandId('b')]),
  catalog,
});

const configurableCatalog: WorldStyleCatalog = Object.freeze({
  defaultProfile: Object.freeze({ profileId: 'aeroheart', profileVersion: 1 }),
  profiles: Object.freeze([Object.freeze({
    profileId: 'aeroheart',
    profileVersion: 1,
    displayName: 'Aeroheart',
    controls: Object.freeze([
      Object.freeze({
        key: 'vitality', capability: 'world.vitality', kind: 'range' as const,
        group: 'world' as const, label: 'World vitality', description: 'Living color strength.',
        min: 0, max: 1, step: 0.05, defaultValue: 0.8,
      }),
      Object.freeze({
        key: 'weather', capability: 'atmosphere.weather', kind: 'choice' as const,
        group: 'atmosphere' as const, label: 'Weather', description: 'Atmospheric expression.',
        options: Object.freeze([
          Object.freeze({ value: 'clear', label: 'Clear' }),
          Object.freeze({ value: 'soft', label: 'Soft' }),
        ]),
        defaultValue: 'clear',
      }),
    ]),
  })]),
});

const appearance = (
  proposalId: string,
  scope: WorldAppearanceProposal['scope'] = { kind: 'global' },
): WorldAppearanceProposal => ({
  proposalId,
  origin: 'settings',
  kind: 'appearance',
  scope,
  baseStyleVersionId: 'world-style:0',
  baseTopologyDigest: 'topology-1',
  profile: { profileId: 'survey-relief', profileVersion: 1 },
});

describe('world customization transactions', () => {
  it('isolates preview, supports discard, and applies an immutable new version', () => {
    const state = controller();
    const preview = state.preview(appearance('p1'));
    expect(preview.validation.ok).toBe(true);
    expect(preview.candidate?.global.profileId).toBe('survey-relief');
    expect(state.current().global.profileId).toBe('celestial-emulsion');
    state.discard(preview.sessionId);
    expect(() => state.apply(preview.sessionId)).toThrow(/unknown/);

    const applied = state.apply(state.preview(appearance('p2')).sessionId);
    expect(applied.revision).toBe(1);
    expect(applied.parentVersionId).toBe('world-style:0');
    expect(state.versions()).toHaveLength(2);
    expect(Object.isFrozen(applied)).toBe(true);
  });

  it('keeps regional scope separate and rolls back by appending history', () => {
    const state = controller();
    const initial = state.current();
    const applied = state.apply(state.preview(appearance('regional', {
      kind: 'region', islandId: islandId('a'),
    })).sessionId);
    expect(applied.global).toEqual(initial.global);
    expect(applied.regions).toEqual([{
      islandId: islandId('a'), profileId: 'survey-relief', profileVersion: 1,
    }]);

    const rolledBack = state.rollback(initial.versionId);
    expect(rolledBack.revision).toBe(2);
    expect(rolledBack.global).toEqual(initial.global);
    expect(rolledBack.regions).toEqual([]);
    expect(state.versions()).toHaveLength(3);
  });

  it('rejects stale, topology-changing, unknown, and structural proposals', () => {
    const state = controller();
    const stale = state.preview({ ...appearance('stale'), baseStyleVersionId: 'old' });
    expect(stale.validation.issues.map((value) => value.code)).toContain('stale-style-version');
    const changed = state.preview({ ...appearance('changed'), baseTopologyDigest: 'other' });
    expect(changed.validation.issues).toContainEqual(expect.objectContaining({
      code: 'topology-changed', protectedValue: true,
    }));
    const unknown = state.preview({
      ...appearance('unknown'), profile: { profileId: 'missing', profileVersion: 1 },
    });
    expect(unknown.validation.issues.map((value) => value.code)).toContain('unknown-style-profile');
    const structural = state.preview({
      proposalId: 'move',
      origin: 'companion',
      kind: 'structural',
      scope: { kind: 'global' },
      baseStyleVersionId: state.current().versionId,
      baseTopologyDigest: state.topologyDigest,
      operation: { kind: 'move-region', islandId: islandId('a') },
    });
    expect(structural.validation.issues).toContainEqual(expect.objectContaining({
      code: 'structural-preview-unavailable', protectedValue: true,
    }));
    expect(() => state.apply(structural.sessionId)).toThrow(/not applicable/);
  });

  it('falls back safely when a persisted profile is removed', () => {
    const resolution = resolveWorldStyleVersion({
      versionId: 'legacy',
      revision: 4,
      parentVersionId: null,
      global: { profileId: 'removed', profileVersion: 3 },
      regions: [{ islandId: islandId('a'), profileId: 'missing', profileVersion: 1 }],
      appliedFromProposalId: null,
    }, catalog);
    expect(resolution.version.global).toEqual(catalog.defaultProfile);
    expect(resolution.version.regions).toEqual([]);
    expect(resolution.warnings).toHaveLength(2);
  });

  it('validates sparse style-specific parameters and resolves complete immutable values', () => {
    const state = new WorldCustomizationController({
      topologyDigest: 'topology-1',
      regionIds: new Set([islandId('a')]),
      catalog: configurableCatalog,
    });
    expect(state.current().global.parameters).toEqual({ vitality: 0.8, weather: 'clear' });
    const preview = state.preview({
      proposalId: 'tune', origin: 'companion', kind: 'appearance', scope: { kind: 'global' },
      baseStyleVersionId: state.current().versionId,
      baseTopologyDigest: state.topologyDigest,
      profile: { profileId: 'aeroheart', profileVersion: 1, parameters: { vitality: 0.35 } },
    });
    expect(preview.validation.ok).toBe(true);
    expect(preview.candidate?.global.parameters).toEqual({ vitality: 0.35, weather: 'clear' });
    expect(Object.isFrozen(preview.candidate?.global.parameters)).toBe(true);
  });

  it('rejects unknown and out-of-range AI-authored parameter values before preview', () => {
    const state = new WorldCustomizationController({
      topologyDigest: 'topology-1', regionIds: new Set(), catalog: configurableCatalog,
    });
    const base = {
      origin: 'companion' as const, kind: 'appearance' as const, scope: { kind: 'global' as const },
      baseStyleVersionId: state.current().versionId, baseTopologyDigest: state.topologyDigest,
    };
    const invalid = state.preview({
      ...base, proposalId: 'invalid',
      profile: { profileId: 'aeroheart', profileVersion: 1, parameters: { vitality: 2 } },
    });
    expect(invalid.validation.issues.map((issue) => issue.code)).toContain('invalid-style-parameter');
    const unknown = state.preview({
      ...base, proposalId: 'unknown-parameter',
      profile: { profileId: 'aeroheart', profileVersion: 1, parameters: { sparkle: true } },
    });
    expect(unknown.validation.issues.map((issue) => issue.code)).toContain('unknown-style-parameter');
  });
});

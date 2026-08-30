import { describe, expect, it } from 'vitest';
import { BLUE_HOUR_THEME, DAWN_THEME } from '../src/system.js';
import {
  DEFAULT_WORLD_ART_PROFILE,
  ORIGIN_LANDSCAPE,
  SURVEY_RELIEF,
  WORLD_ART_PROFILES,
  resolveWorldStyleParameters,
  worldStyleControls,
  worldArtProfile,
} from '../src/world-profiles.js';
import { validateWorldStyleControlManifest } from '../src/world-style-capabilities.js';

describe('world art profiles', () => {
  it('offers materially different silhouettes over one protected topology contract', () => {
    expect(ORIGIN_LANDSCAPE.geometry.landmark).not.toBe(SURVEY_RELIEF.geometry.landmark);
    expect(ORIGIN_LANDSCAPE.geometry.evidence).not.toBe(SURVEY_RELIEF.geometry.evidence);
    expect(ORIGIN_LANDSCAPE.geometry.landmarkHeight)
      .not.toBe(SURVEY_RELIEF.geometry.landmarkHeight);
    expect(ORIGIN_LANDSCAPE.compatibilityKey).toBe(SURVEY_RELIEF.compatibilityKey);
    expect(ORIGIN_LANDSCAPE.semanticChannels).toEqual(SURVEY_RELIEF.semanticChannels);
    expect(ORIGIN_LANDSCAPE.palette.sky).not.toBe(ORIGIN_LANDSCAPE.palette.terrain);
  });

  it('keeps exposure and art profile as orthogonal axes', () => {
    const combinations = [DAWN_THEME, BLUE_HOUR_THEME].flatMap((theme) =>
      Object.values(WORLD_ART_PROFILES).map((profile) => ({ theme: theme.name, profile: profile.profileId })),
    );
    expect(combinations).toEqual([
      { theme: 'dawn', profile: 'origin-landscape' },
      { theme: 'dawn', profile: 'survey-relief' },
      { theme: 'blue-hour', profile: 'origin-landscape' },
      { theme: 'blue-hour', profile: 'survey-relief' },
    ]);
  });

  it('uses a deterministic safe fallback for unknown or removed profiles', () => {
    expect(worldArtProfile('missing')).toBe(DEFAULT_WORLD_ART_PROFILE);
    expect(worldArtProfile('survey-relief', 99)).toBe(DEFAULT_WORLD_ART_PROFILE);
    expect(worldArtProfile('survey-relief')).toBe(SURVEY_RELIEF);
  });

  it('gives each style its own capability-backed controls and resolves dynamic Aeroheart values', () => {
    expect(worldStyleControls('origin-landscape').map((control) => control.capability)).toContain('material.transmission');
    expect(worldStyleControls('survey-relief').map((control) => control.capability)).toContain('detail.contours');
    expect(worldStyleControls('origin-landscape')).not.toEqual(worldStyleControls('survey-relief'));

    const defaults = resolveWorldStyleParameters('origin-landscape');
    const tuned = worldArtProfile('origin-landscape', 1, {
      ...defaults,
      vitality: 0.1,
      glass: 0.2,
      'garden-density': 0.1,
    });
    expect(tuned.palette.terrain).not.toBe(ORIGIN_LANDSCAPE.palette.terrain);
    expect(tuned.material.gloss).toBeLessThan(ORIGIN_LANDSCAPE.material.gloss);
    expect(tuned.geometry.detailCount).toBeLessThan(ORIGIN_LANDSCAPE.geometry.detailCount);
    expect(worldArtProfile('origin-landscape', 1, defaults)).toEqual(
      worldArtProfile('origin-landscape', 1, defaults),
    );
  });

  it('rejects model-authored controls that invent bindings or widen safe capability ranges', () => {
    expect(validateWorldStyleControlManifest([{
      key: 'magic', capability: 'renderer.execute-code', kind: 'range', group: 'world',
      label: 'Magic', description: 'Unsafe invented binding.', min: 0, max: 1, step: 0.1,
      defaultValue: 0.5,
    }])).toContainEqual(expect.objectContaining({ key: 'magic' }));
    expect(validateWorldStyleControlManifest([{
      key: 'vitality', capability: 'world.vitality', kind: 'range', group: 'world',
      label: 'Vitality', description: 'Too broad.', min: -4, max: 4, step: 0.1,
      defaultValue: 0.5,
    }])).toContainEqual(expect.objectContaining({ key: 'vitality' }));
    expect(validateWorldStyleControlManifest(worldStyleControls('origin-landscape'))).toEqual([]);
  });
});

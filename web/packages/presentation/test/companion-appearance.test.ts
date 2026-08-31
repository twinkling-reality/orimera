import { describe, expect, it } from 'vitest';
import {
  companionAppearanceConfiguration,
  NATIVE_COMPANION_PROTOTYPE,
  resolveCompanionAppearance,
} from '../src/companion-appearance.js';

describe('Companion appearance configuration', () => {
  it('keeps appearance and motion in a versioned contract outside the memory graph', () => {
    const result = resolveCompanionAppearance(NATIVE_COMPANION_PROTOTYPE);
    expect(result.issues).toEqual([]);
    expect(result.configuration.companionModelVersion).toBe(3);
    expect(result.configuration.motionProfile).not.toBe(
      result.configuration.reducedMotionProfile,
    );
  });

  it('derives the verified silhouette, colour, and two-eye expression from saved choices', () => {
    const configured = companionAppearanceConfiguration({
      body: 'cloud', color: 'rose', face: 'curious',
    });
    expect(resolveCompanionAppearance(configured)).toEqual({ configuration: configured, issues: [] });
    expect(configured.bodyColor).toBe('#f13f8e');
  });

  it('fails closed instead of reinterpreting a newer saved model', () => {
    const result = resolveCompanionAppearance({
      ...NATIVE_COMPANION_PROTOTYPE,
      companionModelVersion: 4,
    });
    expect(result.configuration).toEqual(NATIVE_COMPANION_PROTOTYPE);
    expect(result.issues).toEqual(['unsupported-model-version']);
  });
});

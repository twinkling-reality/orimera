import { describe, expect, it } from 'vitest';
import {
  WORLD_STYLE_MODULES,
  WORLD_STYLE_RECIPES,
  WorldStyleRegistry,
  productWorldStyleIds,
  type WorldStyleRecipeV1,
} from '../src/world-profiles.js';

const registryFrom = (recipes: readonly WorldStyleRecipeV1[]): WorldStyleRegistry =>
  new WorldStyleRegistry({
    recipes,
    modules: WORLD_STYLE_MODULES,
    defaultProfile: { profileId: 'origin-landscape', profileVersion: 1 },
  });

describe('world style recipe registry', () => {
  it('round trips recipes as inert JSON and compiles the same profiles', () => {
    const serialized = JSON.stringify(WORLD_STYLE_RECIPES);
    expect(serialized).not.toContain('function');
    const recipes = JSON.parse(serialized) as WorldStyleRecipeV1[];
    const registry = registryFrom(recipes);
    const supplied = {
      vitality: 0.2,
      glass: 0.9,
      'relationship-energy': 0.4,
      'garden-density': 0.3,
      'horizon-softness': 0.7,
      'surface-finish': 'clear-lens',
      'world-tempo': 1.25,
    };
    expect(registry.profile('origin-landscape', 1, supplied)).toEqual(
      registryFrom(WORLD_STYLE_RECIPES).profile('origin-landscape', 1, supplied),
    );
  });

  it('keeps developer comparison recipes out of product preferences', () => {
    expect(productWorldStyleIds()).toEqual(['origin-landscape']);
    expect(registryFrom(WORLD_STYLE_RECIPES).recipe('survey-relief')?.availability).toBe('developer');
  });

  it('makes every advertised developer control materially resolve through its module', () => {
    const registry = registryFrom(WORLD_STYLE_RECIPES);
    const low = registry.profile('survey-relief', 1, {
      'contour-density': 0,
      'technical-contrast': 0,
    });
    const high = registry.profile('survey-relief', 1, {
      'contour-density': 1,
      'technical-contrast': 1,
    });
    expect(low.geometry.detailCount).toBeLessThan(high.geometry.detailCount);
    expect(low.material.edgeStrength).toBeLessThan(high.material.edgeStrength);
    expect(low.palette.terrain).not.toBe(high.palette.terrain);
    expect(low.ui.colors).not.toEqual(high.ui.colors);
  });

  it('fails closed when a serialized recipe names unreviewed executable behavior', () => {
    const base = WORLD_STYLE_RECIPES[0]!;
    const invalid: WorldStyleRecipeV1 = { ...base, modules: ['unreviewed-module-v1'] };
    expect(() => registryFrom([invalid])).toThrow(/unknown world style module/);
  });

  it('fails closed when serialized visual data names an unregistered CSS treatment', () => {
    const base = WORLD_STYLE_RECIPES[0]!;
    const invalid = {
      ...base,
      profile: {
        ...base.profile,
        ui: {
          ...base.profile.ui,
          motion: { ...base.profile.ui.motion, easing: 'steps(400)' },
        },
      },
    } as WorldStyleRecipeV1;
    expect(() => registryFrom([invalid])).toThrow(/unregistered origin-landscape UI easing/);
  });

  it('rejects controls and modules whose capability contracts do not match exactly', () => {
    const base = WORLD_STYLE_RECIPES[0]!;
    const missingControl: WorldStyleRecipeV1 = {
      ...base,
      controls: base.controls.filter((control) => control.capability !== 'motion.tempo'),
    };
    expect(() => registryFrom([missingControl])).toThrow(/has no control/);
  });
});

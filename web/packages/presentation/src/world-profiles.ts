import type { WorldStyleParameterDefinition } from '@exulanica/atlas-core';
import {
  MIN_SURFACE_PRESENCE,
  contrastRatio,
  deriveWorldUiColors,
  interfacePaletteFromWorld,
  mixHex,
  perceptualColour,
  worldSilhouetteTone,
  type WorldArtProfile,
  type WorldArtProfileSource,
  type WorldAtmosphereForm,
  type WorldInterfacePalette,
  type WorldPalette,
  type WorldSurfaceForm,
  type WorldUiColors,
  type WorldUiRecipe,
  type WorldUiStyle,
} from './world-style-model.js';
import {
  MEDIA_SAMPLE_EDGE,
  readSourceLight,
  sourceLightParameters,
  type MediaSample,
  type SourceLightReading,
} from './media-palette.js';
import { WORLD_STYLE_MODULES } from './world-style-modules.js';
import {
  WorldStyleRegistry,
  type WorldStyleParameters,
} from './world-style-registry.js';
import {
  AEROHEART_CONTROLS,
  SURVEY_RELIEF_CONTROLS,
  WORLD_STYLE_RECIPES,
  type WorldStyleRecipeV1,
} from './world-style-recipes.js';

export type WorldArtProfileId = string;
export type {
  MediaSample,
  SourceLightReading,
  WorldArtProfile,
  WorldArtProfileSource,
  WorldAtmosphereForm,
  WorldInterfacePalette,
  WorldPalette,
  WorldSurfaceForm,
  WorldStyleParameters,
  WorldStyleRecipeV1,
  WorldUiColors,
  WorldUiRecipe,
  WorldUiStyle,
};
export {
  AEROHEART_CONTROLS,
  MEDIA_SAMPLE_EDGE,
  MIN_SURFACE_PRESENCE,
  SURVEY_RELIEF_CONTROLS,
  WORLD_STYLE_MODULES,
  WORLD_STYLE_RECIPES,
  WorldStyleRegistry,
  contrastRatio,
  deriveWorldUiColors,
  interfacePaletteFromWorld,
  mixHex,
  readSourceLight,
  sourceLightParameters,
  perceptualColour,
  worldSilhouetteTone,
};

export const WORLD_STYLE_REGISTRY = new WorldStyleRegistry({
  recipes: WORLD_STYLE_RECIPES,
  modules: WORLD_STYLE_MODULES,
  defaultProfile: { profileId: 'origin-landscape', profileVersion: 1 },
});

/** Exact inert recipe contract mirrored by the backend registry handshake. */
export const WORLD_STYLE_CONTRACT_COMMIT =
  '55b123627314d328fba3850eb607d8a7682a8cad';

/** The authored Aeroheart base and developer comparison stay topology-compatible. */
export const ORIGIN_LANDSCAPE = WORLD_STYLE_REGISTRY.profile('origin-landscape', 1);
export const SURVEY_RELIEF = WORLD_STYLE_REGISTRY.profile('survey-relief', 1);

export const WORLD_ART_PROFILES: Readonly<Record<string, WorldArtProfile>> = Object.freeze(
  Object.fromEntries(WORLD_STYLE_RECIPES.map((recipe) => [
    recipe.profile.profileId,
    WORLD_STYLE_REGISTRY.profile(recipe.profile.profileId, recipe.profile.profileVersion),
  ])),
);

export const DEFAULT_WORLD_ART_PROFILE = ORIGIN_LANDSCAPE;
export const WORLD_STYLE_CATALOG = WORLD_STYLE_REGISTRY.catalog();

export function worldStyleControls(
  id: string,
  version = 1,
): readonly WorldStyleParameterDefinition[] {
  return WORLD_STYLE_REGISTRY.controls(id, version);
}

export function resolveWorldStyleParameters(
  id: string,
  supplied: Readonly<Record<string, unknown>> = {},
  version = 1,
): WorldStyleParameters {
  return WORLD_STYLE_REGISTRY.resolveParameters(id, version, supplied);
}

export function worldArtProfile(
  id: string,
  version = 1,
  supplied?: Readonly<Record<string, unknown>>,
): WorldArtProfile {
  return WORLD_STYLE_REGISTRY.profile(id, version, supplied);
}

export function worldStyleRecipe(id: string, version = 1): WorldStyleRecipeV1 | null {
  return WORLD_STYLE_REGISTRY.recipe(id, version);
}

export function productWorldStyleIds(): readonly string[] {
  return Object.freeze(WORLD_STYLE_REGISTRY.productRecipes().map((recipe) => recipe.profile.profileId));
}

export function productWorldStyleReferences(): readonly Readonly<{
  profileId: string;
  profileVersion: number;
}>[] {
  return Object.freeze(WORLD_STYLE_REGISTRY.productRecipes().map((recipe) => Object.freeze({
    profileId: recipe.profile.profileId,
    profileVersion: recipe.profile.profileVersion,
  })));
}

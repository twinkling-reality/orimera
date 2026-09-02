import type { WorldStyleParameterValue } from '@orimera/atlas-core';
import { mixHex, oklchHex, type WorldArtProfileSource } from './world-style-model.js';

export interface WorldStyleModule {
  readonly moduleId: string;
  readonly capabilities: readonly string[];
  apply(
    source: WorldArtProfileSource,
    values: ReadonlyMap<string, WorldStyleParameterValue>,
  ): WorldArtProfileSource;
}

const numberValue = (
  values: ReadonlyMap<string, WorldStyleParameterValue>,
  capability: string,
): number => {
  const value = values.get(capability);
  if (typeof value !== 'number') throw new TypeError(`missing numeric world style capability: ${capability}`);
  return value;
};

const choiceValue = (
  values: ReadonlyMap<string, WorldStyleParameterValue>,
  capability: string,
): string => {
  const value = values.get(capability);
  if (typeof value !== 'string') throw new TypeError(`missing choice world style capability: ${capability}`);
  return value;
};

const AEROHEART_OPTICS: WorldStyleModule = Object.freeze({
  moduleId: 'aeroheart-optics-v1',
  capabilities: Object.freeze([
    'world.vitality',
    'material.transmission',
    'relationships.energy',
    'detail.ecology',
    'atmosphere.softness',
  ]),
  apply(
    source: WorldArtProfileSource,
    values: ReadonlyMap<string, WorldStyleParameterValue>,
  ): WorldArtProfileSource {
    const vitality = numberValue(values, 'world.vitality');
    const glass = numberValue(values, 'material.transmission');
    const energy = numberValue(values, 'relationships.energy');
    const density = numberValue(values, 'detail.ecology');
    const softness = numberValue(values, 'atmosphere.softness');
    return {
      ...source,
      geometry: {
        ...source.geometry,
        detailCount: Math.round(4 + density * 7),
        expansionCount: Math.round(3 + density * 4),
      },
      material: {
        ...source.material,
        emissiveStrength: 0.16 + energy * 0.7,
        opacity: 0.34 + glass * 0.58,
        gloss: 0.38 + glass * 0.6,
        edgeStrength: 0.58 + glass * 0.4,
      },
      palette: {
        sky: mixHex('#cfe8ef', '#98cfdb', vitality),
        haze: mixHex('#fff7ef', '#fffdf8', softness),
        terrain: mixHex('#f5f8f2', '#e8f5ef', vitality),
        terrainLift: mixHex('#e7f3df', '#d2eadb', vitality),
        path: mixHex('#ffac38', '#ffac38', energy),
        stone: mixHex('#fff8ee', '#fffdf8', glass),
        stoneShadow: mixHex('#c9d3ea', '#aebfe2', vitality),
        paper: mixHex('#fffaf2', '#fffefb', glass),
        brass: mixHex('#f96858', '#f96858', energy),
        sun: mixHex('#fff0b5', '#fff7d1', vitality),
      },
    };
  },
});

/**
 * The interface's own colour, from four bounded registers.
 *
 * This is the reviewed executable half of "take the colour from my photographs". The reading is
 * done by `media-palette.ts`, which is pure and produces only numbers; this is the only place
 * those numbers become colours, and it is trusted application code rather than data. That split
 * is what keeps the feature inside the customization contract: a proposal carries four values in
 * a registered range, and no proposal can carry a colour.
 *
 * Every output is constructed rather than interpolated between authored endpoints, because the
 * hue is a full circle and there is no pair of endpoints a circle can be mixed between. Lightness
 * and chroma stay inside ranges the derivation can build a readable interface from, so the person
 * chooses the hue and the system keeps the guarantee.
 */
const SOURCE_LIGHT: WorldStyleModule = Object.freeze({
  moduleId: 'source-light-v1',
  capabilities: Object.freeze([
    'interface.hue', 'interface.warmth', 'interface.depth', 'interface.light',
  ]),
  apply(
    source: WorldArtProfileSource,
    values: ReadonlyMap<string, WorldStyleParameterValue>,
  ): WorldArtProfileSource {
    const hue = numberValue(values, 'interface.hue') * Math.PI * 2;
    const warmth = numberValue(values, 'interface.warmth');
    const depth = numberValue(values, 'interface.depth');
    const light = numberValue(values, 'interface.light');
    // The warm mark sits on its own arc and the cool mark a fixed turn off the structural hue, so
    // provenance, uncertainty and structure can never collapse onto one colour whatever a
    // photograph says. The coefficients are solved so that the control defaults reproduce the
    // authored resting palette exactly: a control at rest must change nothing.
    const warmHue = 0.28 + warmth * 1.15;
    const coolHue = hue + Math.PI * 0.41;
    return {
      ...source,
      interfacePalette: {
        ink: oklchHex(0.34 - depth * 0.1, 0.026 + depth * 0.03, hue),
        plate: oklchHex(0.962 + light * 0.028, 0.022 - light * 0.009, warmHue + 0.97),
        structure: oklchHex(0.625 - depth * 0.055, 0.075 + depth * 0.045, hue),
        evidence: oklchHex(0.72 - warmth * 0.1, 0.155 + warmth * 0.13, warmHue),
        uncertain: oklchHex(0.61 - depth * 0.065, 0.09 + depth * 0.036, coolHue),
      },
    };
  },
});

const REGISTERED_SURFACE: WorldStyleModule = Object.freeze({
  moduleId: 'registered-surface-v1',
  capabilities: Object.freeze(['surface.finish']),
  apply(
    source: WorldArtProfileSource,
    values: ReadonlyMap<string, WorldStyleParameterValue>,
  ): WorldArtProfileSource {
    const finish = choiceValue(values, 'surface.finish');
    return {
      ...source,
      ui: {
        ...source.ui,
        material: {
          ...source.ui.material,
          textureOpacity: finish === 'clear-lens' ? 0 : 0.08,
        },
        texture: finish === 'clear-lens'
          ? { kind: 'none', blendMode: 'normal' }
          : { kind: 'paper-grain', blendMode: 'multiply' },
      },
    };
  },
});

const BOUNDED_TEMPO: WorldStyleModule = Object.freeze({
  moduleId: 'bounded-tempo-v1',
  capabilities: Object.freeze(['motion.tempo']),
  apply(
    source: WorldArtProfileSource,
    values: ReadonlyMap<string, WorldStyleParameterValue>,
  ): WorldArtProfileSource {
    const tempo = numberValue(values, 'motion.tempo');
    const scale = (milliseconds: number): number => Math.round(milliseconds / tempo);
    return {
      ...source,
      ui: {
        ...source.ui,
        motion: {
          ...source.ui.motion,
          quickMs: scale(source.ui.motion.quickMs),
          standardMs: scale(source.ui.motion.standardMs),
          deliberateMs: scale(source.ui.motion.deliberateMs),
          idleCycleMs: scale(source.ui.motion.idleCycleMs),
          workingCycleMs: scale(source.ui.motion.workingCycleMs),
          staggerMs: scale(source.ui.motion.staggerMs),
        },
      },
    };
  },
});

const SURVEY_RELIEF_RESPONSE: WorldStyleModule = Object.freeze({
  moduleId: 'survey-relief-response-v1',
  capabilities: Object.freeze(['detail.contours', 'material.technical-contrast']),
  apply(
    source: WorldArtProfileSource,
    values: ReadonlyMap<string, WorldStyleParameterValue>,
  ): WorldArtProfileSource {
    const density = numberValue(values, 'detail.contours');
    const contrast = numberValue(values, 'material.technical-contrast');
    return {
      ...source,
      geometry: {
        ...source.geometry,
        detailCount: Math.round(4 + density * 12),
      },
      material: {
        ...source.material,
        gloss: 0.12 + contrast * 0.28,
        edgeStrength: 0.55 + contrast * 0.45,
      },
      palette: {
        ...source.palette,
        terrain: mixHex('#87887e', '#565c58', contrast),
        terrainLift: mixHex('#a3a395', '#73776f', contrast),
        path: mixHex('#937c5c', '#594834', contrast),
        stone: mixHex('#767c77', '#3f4844', contrast),
      },
    };
  },
});

export const WORLD_STYLE_MODULES: readonly WorldStyleModule[] = Object.freeze([
  AEROHEART_OPTICS,
  REGISTERED_SURFACE,
  BOUNDED_TEMPO,
  SOURCE_LIGHT,
  SURVEY_RELIEF_RESPONSE,
]);

import type { WorldStyleParameterValue } from '@orimera/atlas-core';
import { mixHex, type WorldArtProfileSource } from './world-style-model.js';

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
        sky: mixHex('#769ca4', '#54c5c8', vitality),
        haze: mixHex('#d8cfca', '#f6d8bb', 1 - softness * 0.35),
        terrain: mixHex('#172f38', '#0d4651', vitality),
        terrainLift: mixHex('#315f68', '#4b9da0', vitality),
        path: mixHex('#d9ab72', '#ffdf72', energy),
        stone: mixHex('#e3dfd0', '#fff8df', glass),
        stoneShadow: mixHex('#6d668f', '#8979c7', vitality),
        paper: mixHex('#dedfcf', '#fff8df', glass),
        brass: mixHex('#c87563', '#ff9872', energy),
        sun: mixHex('#e8d8b8', '#fff7cf', vitality),
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
  SURVEY_RELIEF_RESPONSE,
]);

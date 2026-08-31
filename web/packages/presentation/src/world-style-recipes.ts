import type { WorldStyleParameterDefinition } from '@orimera/atlas-core';
import type { WorldArtProfileSource } from './world-style-model.js';

export type WorldStyleAvailability = 'product' | 'developer';
export type WorldStyleRecipeOrigin = 'authored' | 'generated';

/**
 * Serializable style input. A future service or local agent may produce this data, but executable
 * renderer behavior remains limited to the reviewed module IDs registered by the client.
 */
export interface WorldStyleRecipeV1 {
  readonly schemaVersion: 1;
  readonly availability: WorldStyleAvailability;
  readonly origin: WorldStyleRecipeOrigin;
  readonly profile: WorldArtProfileSource;
  readonly controls: readonly WorldStyleParameterDefinition[];
  readonly modules: readonly string[];
}

export const AEROHEART_CONTROLS: readonly WorldStyleParameterDefinition[] = [
  {
    key: 'vitality', capability: 'world.vitality', kind: 'range', group: 'world',
    label: 'Color vitality', description: 'Tunes one shared color family across the memory field and its interface surfaces.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.82,
  },
  {
    key: 'glass', capability: 'material.transmission', kind: 'range', group: 'material',
    label: 'Veil clarity', description: 'Changes the memory weave from soft optical thread to a crisp source image.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.76,
  },
  {
    key: 'relationship-energy', capability: 'relationships.energy', kind: 'range', group: 'motion',
    label: 'Relationship energy', description: 'Controls the visual strength of confirmed relationship filaments.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.68,
  },
  {
    key: 'garden-density', capability: 'detail.ecology', kind: 'range', group: 'detail',
    label: 'Weave detail', description: 'Controls bounded source-thread detail without adding, removing, or implying evidence.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.72,
  },
  {
    key: 'horizon-softness', capability: 'atmosphere.softness', kind: 'range', group: 'atmosphere',
    label: 'Horizon softness', description: 'Changes atmospheric depth without hiding destinations.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.46,
  },
  {
    key: 'surface-finish', capability: 'surface.finish', kind: 'choice', group: 'material',
    label: 'Surface finish', description: 'Uses one registered finish across the field and summoned interface surfaces.',
    options: [
      { value: 'source-paper', label: 'Source paper' },
      { value: 'clear-lens', label: 'Clear lens' },
    ],
    defaultValue: 'source-paper',
  },
  {
    key: 'world-tempo', capability: 'motion.tempo', kind: 'range', group: 'motion',
    label: 'Memory tempo', description: 'Changes the shared ambient and interface cadence inside a calm, bounded range.',
    min: 0.75, max: 1.25, step: 0.05, defaultValue: 1,
  },
];

export const SURVEY_RELIEF_CONTROLS: readonly WorldStyleParameterDefinition[] = [
  {
    key: 'contour-density', capability: 'detail.contours', kind: 'range', group: 'detail',
    label: 'Contour density', description: 'Changes the number of non-semantic survey contour marks.',
    min: 0, max: 1, step: 0.1, defaultValue: 0.55,
  },
  {
    key: 'technical-contrast', capability: 'material.technical-contrast', kind: 'range', group: 'material',
    label: 'Technical contrast', description: 'Controls separation between survey strata and their field.',
    min: 0, max: 1, step: 0.1, defaultValue: 0.7,
  },
];

const AEROHEART_SOURCE: WorldArtProfileSource = {
  profileId: 'origin-landscape',
  profileVersion: 1,
  displayName: 'Aeroheart',
  description: 'Photographic memory veils above a luminous relationship tide.',
  compatibilityKey: 'atlas-topology-v1',
  geometry: {
    landmark: 'aero-beacon',
    evidence: 'memory-lens',
    expansion: 'living-buds',
    landmarkHeight: 2.3,
    landmarkWidth: 2.4,
    evidenceSpread: 1.7,
    detailCount: 8,
    expansionCount: 5,
  },
  material: {
    emissiveStrength: 0.58,
    opacity: 0.72,
    metalness: 0.18,
    gloss: 0.82,
    edgeStrength: 0.86,
  },
  palette: {
    sky: '#5ea8b2',
    haze: '#e8d8c7',
    terrain: '#153f4b',
    terrainLift: '#609b9c',
    path: '#ffd27a',
    stone: '#f7f1da',
    stoneShadow: '#7c71b5',
    paper: '#f8f3dc',
    brass: '#ff916f',
    sun: '#fff5cf',
  },
  semanticChannels: {
    provenance: ['hue', 'shape'],
    confirmation: ['hue', 'stroke'],
    focus: ['contrast', 'outline'],
  },
  ui: {
    typography: {
      body: '"Avenir Next", "Segoe UI Variable", ui-sans-serif, system-ui, sans-serif',
      display: '"Avenir Next", "Segoe UI Variable Display", ui-sans-serif, system-ui, sans-serif',
      utility: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
      companion: '"Avenir Next", Avenir, ui-sans-serif, system-ui, sans-serif',
    },
    material: {
      worldBlur: 8,
      systemBlur: 18,
      companionBlur: 24,
      worldSaturation: 1,
      systemSaturation: 1.15,
      companionSaturation: 1.12,
      textureOpacity: 0.08,
    },
    texture: { kind: 'paper-grain', blendMode: 'multiply' },
    motion: {
      quickMs: 130,
      standardMs: 220,
      deliberateMs: 320,
      idleCycleMs: 5_200,
      workingCycleMs: 1_250,
      staggerMs: 140,
      easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
    },
  },
};

const SURVEY_RELIEF_SOURCE: WorldArtProfileSource = {
  profileId: 'survey-relief',
  profileVersion: 1,
  displayName: 'Survey Relief (experimental)',
  description: 'A topology-compatible field-ledger study for renderer regression tests.',
  compatibilityKey: 'atlas-topology-v1',
  geometry: {
    landmark: 'survey-strata',
    evidence: 'indexed-bays',
    expansion: 'survey-stakes',
    landmarkHeight: 2.1,
    landmarkWidth: 0.9,
    evidenceSpread: 1.55,
    detailCount: 8,
    expansionCount: 5,
  },
  material: {
    emissiveStrength: 0.02,
    opacity: 1,
    metalness: 0.14,
    gloss: 0.28,
    edgeStrength: 0.9,
  },
  palette: {
    sky: '#d9dfdc',
    haze: '#b7c0ba',
    terrain: '#74766c',
    terrainLift: '#8c8c7e',
    path: '#725f46',
    stone: '#59605c',
    stoneShadow: '#343b38',
    paper: '#ddd8c9',
    brass: '#896b42',
    sun: '#e7cf9d',
  },
  semanticChannels: {
    provenance: ['hue', 'shape'],
    confirmation: ['hue', 'stroke'],
    focus: ['contrast', 'outline'],
  },
  ui: {
    typography: {
      body: '"Arial Narrow", "Avenir Next Condensed", ui-sans-serif, system-ui, sans-serif',
      display: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
      utility: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
      companion: '"Arial Narrow", "Avenir Next Condensed", ui-sans-serif, system-ui, sans-serif',
    },
    material: {
      worldBlur: 0,
      systemBlur: 0,
      companionBlur: 0,
      worldSaturation: 0.82,
      systemSaturation: 0.88,
      companionSaturation: 0.9,
      textureOpacity: 0.14,
    },
    texture: { kind: 'contour-grid', blendMode: 'multiply' },
    motion: {
      quickMs: 80,
      standardMs: 120,
      deliberateMs: 160,
      idleCycleMs: 4_000,
      workingCycleMs: 900,
      staggerMs: 90,
      easing: 'linear',
    },
  },
};

export const WORLD_STYLE_RECIPES: readonly WorldStyleRecipeV1[] = [
  {
    schemaVersion: 1,
    availability: 'product',
    origin: 'authored',
    profile: AEROHEART_SOURCE,
    controls: AEROHEART_CONTROLS,
    modules: ['aeroheart-optics-v1', 'registered-surface-v1', 'bounded-tempo-v1'],
  },
  {
    schemaVersion: 1,
    availability: 'developer',
    origin: 'authored',
    profile: SURVEY_RELIEF_SOURCE,
    controls: SURVEY_RELIEF_CONTROLS,
    modules: ['survey-relief-response-v1'],
  },
];

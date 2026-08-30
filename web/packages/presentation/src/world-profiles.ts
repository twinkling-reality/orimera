import type {
  WorldStyleCatalog,
  WorldStyleParameterDefinition,
  WorldStyleParameterValue,
} from '@orimera/atlas-core';
import { assertWorldStyleControlManifest } from './world-style-capabilities.js';

export type WorldArtProfileId = 'origin-landscape' | 'survey-relief';

/**
 * Appearance tokens are intentionally separate from topology. A profile may change the visual
 * silhouette inside authored bounds, but it never changes sockets, collision, navigation,
 * evidence bindings, or destination positions.
 */
export interface WorldArtProfile {
  readonly profileId: WorldArtProfileId;
  readonly profileVersion: 1;
  readonly displayName: string;
  readonly description: string;
  readonly compatibilityKey: 'atlas-topology-v1';
  readonly geometry: {
    readonly landmark: 'aero-beacon' | 'survey-strata';
    readonly evidence: 'memory-lens' | 'indexed-bays';
    readonly expansion: 'living-buds' | 'survey-stakes';
    readonly landmarkHeight: number;
    readonly landmarkWidth: number;
    readonly evidenceSpread: number;
    readonly detailCount: number;
    readonly expansionCount: number;
  };
  readonly material: {
    readonly emissiveStrength: number;
    readonly opacity: number;
    readonly metalness: number;
    readonly gloss: number;
    readonly edgeStrength: number;
  };
  /** World-only colors. UI exposure tokens must not recolor the landscape into a screen wash. */
  readonly palette: {
    readonly sky: string;
    readonly haze: string;
    readonly terrain: string;
    readonly terrainLift: string;
    readonly path: string;
    readonly stone: string;
    readonly stoneShadow: string;
    readonly paper: string;
    readonly brass: string;
    readonly sun: string;
  };
  readonly semanticChannels: {
    readonly provenance: readonly ['hue', 'shape'];
    readonly confirmation: readonly ['hue', 'stroke'];
    readonly focus: readonly ['contrast', 'outline'];
  };
}

const profile = (value: WorldArtProfile): WorldArtProfile => {
  for (const [name, number] of Object.entries(value.geometry)) {
    if (typeof number === 'number' && (!Number.isFinite(number) || number < 0)) {
      throw new TypeError(`invalid ${value.profileId} geometry token ${name}`);
    }
  }
  for (const [name, number] of Object.entries(value.material)) {
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      throw new TypeError(`invalid ${value.profileId} material token ${name}`);
    }
  }
  for (const [name, colour] of Object.entries(value.palette)) {
    if (!/^#[0-9a-f]{6}$/i.test(colour)) {
      throw new TypeError(`invalid ${value.profileId} palette token ${name}`);
    }
  }
  return Object.freeze({
    ...value,
    geometry: Object.freeze({ ...value.geometry }),
    material: Object.freeze({ ...value.material }),
    palette: Object.freeze({ ...value.palette }),
    semanticChannels: Object.freeze({
      provenance: Object.freeze([...value.semanticChannels.provenance]) as readonly ['hue', 'shape'],
      confirmation: Object.freeze([...value.semanticChannels.confirmation]) as readonly ['hue', 'stroke'],
      focus: Object.freeze([...value.semanticChannels.focus]) as readonly ['contrast', 'outline'],
    }),
  });
};

/**
 * The authored default. Aeroheart combines a living nature/technology world with precise vector
 * signals. Its semantic forms stay stable while the parameter manifest safely changes expression.
 */
export const ORIGIN_LANDSCAPE = profile({
  profileId: 'origin-landscape',
  profileVersion: 1,
  displayName: 'Aeroheart',
  description: 'A bright living memory ecology of glass lenses, water paths, and vector signals.',
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
    sky: '#4cc6f4',
    haze: '#dff8f6',
    terrain: '#3db65d',
    terrainLift: '#78d879',
    path: '#ff8a1f',
    stone: '#f4fbff',
    stoneShadow: '#0b68a0',
    paper: '#bfeeff',
    brass: '#ff8a1f',
    sun: '#fff4a3',
  },
  semanticChannels: {
    provenance: ['hue', 'shape'],
    confirmation: ['hue', 'stroke'],
    focus: ['contrast', 'outline'],
  },
});

export const AEROHEART_CONTROLS: readonly WorldStyleParameterDefinition[] = assertWorldStyleControlManifest(Object.freeze([
  Object.freeze({
    key: 'vitality', capability: 'world.vitality', kind: 'range', group: 'world',
    label: 'World vitality', description: 'Moves the living world from quiet to vividly saturated.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.82,
  }),
  Object.freeze({
    key: 'glass', capability: 'material.transmission', kind: 'range', group: 'material',
    label: 'Glass character', description: 'Changes memory lenses from soft translucent forms to crisp optical glass.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.76,
  }),
  Object.freeze({
    key: 'relationship-energy', capability: 'relationships.energy', kind: 'range', group: 'motion',
    label: 'Relationship energy', description: 'Controls the visual strength of confirmed relationship paths.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.68,
  }),
  Object.freeze({
    key: 'garden-density', capability: 'detail.ecology', kind: 'range', group: 'detail',
    label: 'Garden density', description: 'Controls decorative growth without adding or removing memories.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.72,
  }),
  Object.freeze({
    key: 'horizon-softness', capability: 'atmosphere.softness', kind: 'range', group: 'atmosphere',
    label: 'Horizon softness', description: 'Changes atmospheric depth without hiding destinations.',
    min: 0, max: 1, step: 0.05, defaultValue: 0.46,
  }),
]));

export const SURVEY_RELIEF_CONTROLS: readonly WorldStyleParameterDefinition[] = assertWorldStyleControlManifest(Object.freeze([
  Object.freeze({
    key: 'contour-density', capability: 'detail.contours', kind: 'range', group: 'detail',
    label: 'Contour density', description: 'Changes the number of non-semantic survey contour marks.',
    min: 0, max: 1, step: 0.1, defaultValue: 0.55,
  }),
  Object.freeze({
    key: 'technical-contrast', capability: 'material.technical-contrast', kind: 'range', group: 'material',
    label: 'Technical contrast', description: 'Controls separation between survey strata and their field.',
    min: 0, max: 1, step: 0.1, defaultValue: 0.7,
  }),
]));

/** Kept as a developer comparison profile, not offered as the product's default identity. */
export const SURVEY_RELIEF = profile({
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
});

export const WORLD_ART_PROFILES: Readonly<Record<WorldArtProfileId, WorldArtProfile>> = Object.freeze({
  'origin-landscape': ORIGIN_LANDSCAPE,
  'survey-relief': SURVEY_RELIEF,
});

export const DEFAULT_WORLD_ART_PROFILE = ORIGIN_LANDSCAPE;

export const WORLD_STYLE_CATALOG: WorldStyleCatalog = Object.freeze({
  defaultProfile: Object.freeze({
    profileId: DEFAULT_WORLD_ART_PROFILE.profileId,
    profileVersion: DEFAULT_WORLD_ART_PROFILE.profileVersion,
  }),
  profiles: Object.freeze(Object.values(WORLD_ART_PROFILES).map((value) => Object.freeze({
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    displayName: value.displayName,
    description: value.description,
    controls: value.profileId === ORIGIN_LANDSCAPE.profileId
      ? AEROHEART_CONTROLS
      : SURVEY_RELIEF_CONTROLS,
  }))),
});

const channel = (hex: string, offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16);
const mixHex = (from: string, to: string, amount: number): string => {
  const t = Math.max(0, Math.min(1, amount));
  const mixed = [1, 3, 5].map((offset) => Math.round(channel(from, offset) * (1 - t) + channel(to, offset) * t));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
};

export type WorldStyleParameters = Readonly<Record<string, WorldStyleParameterValue>>;

export function worldStyleControls(id: string): readonly WorldStyleParameterDefinition[] {
  return id === ORIGIN_LANDSCAPE.profileId
    ? AEROHEART_CONTROLS
    : id === SURVEY_RELIEF.profileId
      ? SURVEY_RELIEF_CONTROLS
      : AEROHEART_CONTROLS;
}

export function resolveWorldStyleParameters(
  id: string,
  supplied: Readonly<Record<string, unknown>> = {},
): WorldStyleParameters {
  const values: Record<string, WorldStyleParameterValue> = {};
  for (const control of worldStyleControls(id)) {
    const candidate = supplied[control.key];
    values[control.key] = control.kind === 'range' && typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.max(control.min, Math.min(control.max, candidate))
      : control.kind === 'choice' && typeof candidate === 'string' && control.options.some((option) => option.value === candidate)
        ? candidate
        : control.kind === 'color' && typeof candidate === 'string' && /^#[0-9a-f]{6}$/i.test(candidate)
          ? candidate
          : control.kind === 'toggle' && typeof candidate === 'boolean'
            ? candidate
            : control.defaultValue;
  }
  return Object.freeze(values);
}

export function worldArtProfile(
  id: string,
  version = 1,
  supplied?: Readonly<Record<string, unknown>>,
): WorldArtProfile {
  const found = WORLD_ART_PROFILES[id as WorldArtProfileId];
  if (found === undefined || found.profileVersion !== version) return DEFAULT_WORLD_ART_PROFILE;
  if (supplied === undefined) return found;
  const parameters = resolveWorldStyleParameters(id, supplied);
  if (found.profileId !== ORIGIN_LANDSCAPE.profileId) return found;
  const vitality = parameters['vitality'] as number;
  const glass = parameters['glass'] as number;
  const energy = parameters['relationship-energy'] as number;
  const density = parameters['garden-density'] as number;
  const softness = parameters['horizon-softness'] as number;
  return profile({
    ...found,
    geometry: {
      ...found.geometry,
      detailCount: Math.round(4 + density * 7),
      expansionCount: Math.round(3 + density * 4),
    },
    material: {
      ...found.material,
      emissiveStrength: 0.16 + energy * 0.7,
      opacity: 0.34 + glass * 0.58,
      gloss: 0.38 + glass * 0.6,
      edgeStrength: 0.58 + glass * 0.4,
    },
    palette: {
      sky: mixHex('#a8ccd7', '#32bff5', vitality),
      haze: mixHex('#d9e6df', '#e7fdff', 1 - softness * 0.55),
      terrain: mixHex('#58725d', '#27c257', vitality),
      terrainLift: mixHex('#78937a', '#86e881', vitality),
      path: mixHex('#bd7041', '#ff8617', energy),
      stone: mixHex('#dce7e9', '#ffffff', glass),
      stoneShadow: mixHex('#426879', '#075d9c', vitality),
      paper: mixHex('#b8d9dd', '#c8f5ff', glass),
      brass: mixHex('#d56f38', '#ff8a17', energy),
      sun: mixHex('#f2df9e', '#fff8bd', vitality),
    },
  });
}

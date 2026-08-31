/**
 * Renderer-neutral visual model shared by authored, personalized, and agent-composed worlds.
 * This file contains no catalog entries and no profile-specific branching.
 */

export type WorldLandmarkForm = 'aero-beacon' | 'survey-strata';
export type WorldEvidenceForm = 'memory-lens' | 'indexed-bays';
export type WorldExpansionForm = 'living-buds' | 'survey-stakes';

const WORLD_LANDMARK_FORMS = new Set<WorldLandmarkForm>(['aero-beacon', 'survey-strata']);
const WORLD_EVIDENCE_FORMS = new Set<WorldEvidenceForm>(['memory-lens', 'indexed-bays']);
const WORLD_EXPANSION_FORMS = new Set<WorldExpansionForm>(['living-buds', 'survey-stakes']);
const WORLD_UI_TEXTURES = new Set(['paper-grain', 'contour-grid', 'none']);
const WORLD_UI_BLEND_MODES = new Set(['normal', 'multiply', 'soft-light']);
const WORLD_UI_EASINGS = new Set(['linear', 'cubic-bezier(0.2, 0.7, 0.2, 1)']);
const WORLD_UI_FONT_FAMILIES = new Set([
  '"Avenir Next", "Segoe UI Variable", ui-sans-serif, system-ui, sans-serif',
  '"Avenir Next", "Segoe UI Variable Display", ui-sans-serif, system-ui, sans-serif',
  'ui-monospace, "SFMono-Regular", Consolas, monospace',
  '"Avenir Next", Avenir, ui-sans-serif, system-ui, sans-serif',
  '"Arial Narrow", "Avenir Next Condensed", ui-sans-serif, system-ui, sans-serif',
]);

export interface WorldPalette {
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
}

export interface WorldUiColors {
  readonly ground: string;
  readonly surface: string;
  readonly raised: string;
  readonly ink: string;
  readonly body: string;
  readonly muted: string;
  readonly accent: string;
  readonly secondary: string;
  readonly focus: string;
  readonly warning: string;
  readonly error: string;
  readonly user: string;
  readonly capture: string;
  readonly inference: string;
  readonly external: string;
  readonly companionSurface: string;
  readonly companionSurfaceHover: string;
  readonly companionText: string;
  readonly companionAccent: string;
  readonly companionSecondary: string;
  readonly companionInk: string;
  readonly companionUnavailable: string;
  readonly shadow: string;
  readonly vignette: string;
}

export interface WorldUiRecipe {
  readonly typography: {
    readonly body: string;
    readonly display: string;
    readonly utility: string;
    readonly companion: string;
  };
  readonly material: {
    readonly worldBlur: number;
    readonly systemBlur: number;
    readonly companionBlur: number;
    readonly worldSaturation: number;
    readonly systemSaturation: number;
    readonly companionSaturation: number;
    readonly textureOpacity: number;
  };
  readonly texture: {
    readonly kind: 'paper-grain' | 'contour-grid' | 'none';
    readonly blendMode: 'normal' | 'multiply' | 'soft-light';
  };
  readonly motion: {
    readonly quickMs: number;
    readonly standardMs: number;
    readonly deliberateMs: number;
    readonly idleCycleMs: number;
    readonly workingCycleMs: number;
    readonly staggerMs: number;
    readonly easing: string;
  };
}

export interface WorldUiStyle extends WorldUiRecipe {
  /** Derived from the world palette. A recipe cannot supply an unrelated component palette. */
  readonly colors: WorldUiColors;
}

export interface WorldArtProfileSource {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly displayName: string;
  readonly description: string;
  readonly compatibilityKey: 'atlas-topology-v1';
  readonly geometry: {
    readonly landmark: WorldLandmarkForm;
    readonly evidence: WorldEvidenceForm;
    readonly expansion: WorldExpansionForm;
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
  readonly palette: WorldPalette;
  readonly semanticChannels: {
    readonly provenance: readonly ['hue', 'shape'];
    readonly confirmation: readonly ['hue', 'stroke'];
    readonly focus: readonly ['contrast', 'outline'];
  };
  readonly ui: WorldUiRecipe;
}

/** A compiled profile is immutable and contains the contrast-corrected component roles. */
export interface WorldArtProfile extends Omit<WorldArtProfileSource, 'ui'> {
  readonly ui: WorldUiStyle;
}

const HEX = /^#[0-9a-f]{6}$/i;
const channel = (hex: string, offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16);

export const mixHex = (from: string, to: string, amount: number): string => {
  const t = Math.max(0, Math.min(1, amount));
  const mixed = [1, 3, 5].map((offset) =>
    Math.round(channel(from, offset) * (1 - t) + channel(to, offset) * t));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
};

const relativeLuminance = (hex: string): number => {
  const linear = [1, 3, 5].map((offset) => {
    const value = channel(hex, offset) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
};

export const contrastRatio = (foreground: string, background: string): number => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
};

const accessibleTone = (candidate: string, background: string, minimum: number): string => {
  if (contrastRatio(candidate, background) >= minimum) return candidate;
  const target = relativeLuminance(background) > 0.42 ? '#000000' : '#ffffff';
  let low = 0;
  let high = 1;
  let resolved = target;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const amount = (low + high) / 2;
    const mixed = mixHex(candidate, target, amount);
    if (contrastRatio(mixed, background) >= minimum) {
      resolved = mixed;
      high = amount;
    } else {
      low = amount;
    }
  }
  return resolved;
};

/** Semantic interface roles always come from the same roots as the rendered world. */
export function deriveWorldUiColors(palette: WorldPalette): WorldUiColors {
  const ground = mixHex(palette.haze, palette.paper, 0.3);
  const surface = mixHex(palette.haze, palette.paper, 0.58);
  const raised = mixHex(palette.paper, palette.sun, 0.18);
  const companionSurface = accessibleTone(palette.terrain, palette.paper, 7);
  return Object.freeze({
    ground,
    surface,
    raised,
    ink: accessibleTone(palette.terrain, raised, 7),
    body: accessibleTone(mixHex(palette.terrain, palette.terrainLift, 0.16), surface, 4.5),
    muted: accessibleTone(mixHex(palette.terrain, palette.haze, 0.26), surface, 4.5),
    accent: accessibleTone(mixHex(palette.terrain, palette.terrainLift, 0.34), surface, 4.5),
    secondary: accessibleTone(palette.brass, surface, 4.5),
    focus: accessibleTone(palette.terrainLift, ground, 3),
    warning: accessibleTone(palette.brass, surface, 4.5),
    error: accessibleTone(mixHex('#a6404c', palette.brass, 0.12), surface, 4.5),
    user: accessibleTone(palette.brass, surface, 4.5),
    capture: accessibleTone(mixHex(palette.terrain, palette.terrainLift, 0.42), surface, 4.5),
    inference: accessibleTone(palette.stoneShadow, surface, 4.5),
    external: accessibleTone(mixHex(palette.stoneShadow, palette.brass, 0.28), surface, 4.5),
    companionSurface,
    companionSurfaceHover: mixHex(companionSurface, palette.terrainLift, 0.18),
    companionText: accessibleTone(palette.paper, companionSurface, 7),
    companionAccent: accessibleTone(palette.sun, companionSurface, 4.5),
    companionSecondary: accessibleTone(palette.terrainLift, companionSurface, 4.5),
    companionInk: companionSurface,
    companionUnavailable: accessibleTone(palette.stoneShadow, companionSurface, 4.5),
    shadow: mixHex(palette.terrain, '#000000', 0.72),
    vignette: mixHex(palette.terrain, '#000000', 0.58),
  });
}

const freezeSource = (source: WorldArtProfileSource): WorldArtProfileSource => Object.freeze({
  ...source,
  geometry: Object.freeze({ ...source.geometry }),
  material: Object.freeze({ ...source.material }),
  palette: Object.freeze({ ...source.palette }),
  semanticChannels: Object.freeze({
    provenance: Object.freeze([...source.semanticChannels.provenance]) as readonly ['hue', 'shape'],
    confirmation: Object.freeze([...source.semanticChannels.confirmation]) as readonly ['hue', 'stroke'],
    focus: Object.freeze([...source.semanticChannels.focus]) as readonly ['contrast', 'outline'],
  }),
  ui: Object.freeze({
    typography: Object.freeze({ ...source.ui.typography }),
    material: Object.freeze({ ...source.ui.material }),
    texture: Object.freeze({ ...source.ui.texture }),
    motion: Object.freeze({ ...source.ui.motion }),
  }),
});

export function validateWorldArtProfileSource(source: WorldArtProfileSource): void {
  if (!/^[a-z][a-z0-9-]*$/.test(source.profileId)) {
    throw new TypeError(`invalid world profile ID: ${source.profileId}`);
  }
  if (!Number.isSafeInteger(source.profileVersion) || source.profileVersion < 1) {
    throw new TypeError(`invalid world profile version: ${source.profileId}`);
  }
  if (source.displayName.trim().length === 0 || source.description.trim().length === 0) {
    throw new TypeError(`world profile metadata is incomplete: ${source.profileId}`);
  }
  if (source.compatibilityKey !== 'atlas-topology-v1') {
    throw new TypeError(`unsupported topology compatibility: ${source.profileId}`);
  }
  if (
    !WORLD_LANDMARK_FORMS.has(source.geometry.landmark) ||
    !WORLD_EVIDENCE_FORMS.has(source.geometry.evidence) ||
    !WORLD_EXPANSION_FORMS.has(source.geometry.expansion)
  ) throw new TypeError(`unregistered world geometry form: ${source.profileId}`);
  for (const [name, number] of Object.entries(source.geometry)) {
    if (typeof number === 'number' && (!Number.isFinite(number) || number < 0)) {
      throw new TypeError(`invalid ${source.profileId} geometry token ${name}`);
    }
  }
  for (const [name, number] of Object.entries(source.material)) {
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      throw new TypeError(`invalid ${source.profileId} material token ${name}`);
    }
  }
  for (const [name, colour] of Object.entries(source.palette)) {
    if (!HEX.test(colour)) throw new TypeError(`invalid ${source.profileId} palette token ${name}`);
  }
  for (const [name, family] of Object.entries(source.ui.typography)) {
    if (!WORLD_UI_FONT_FAMILIES.has(family)) {
      throw new TypeError(`unregistered ${source.profileId} UI font ${name}`);
    }
  }
  for (const [name, amount] of Object.entries(source.ui.material)) {
    const max = name === 'textureOpacity' ? 1 : name.endsWith('Saturation') ? 4 : 64;
    if (!Number.isFinite(amount) || amount < 0 || amount > max) {
      throw new TypeError(`invalid ${source.profileId} UI material ${name}`);
    }
  }
  for (const [name, duration] of Object.entries(source.ui.motion)) {
    if (
      name !== 'easing' &&
      (
        typeof duration !== 'number' || duration < 0 || duration > 10_000 ||
        (name.endsWith('CycleMs') && duration === 0)
      )
    ) throw new TypeError(`invalid ${source.profileId} UI motion ${name}`);
  }
  if (!WORLD_UI_TEXTURES.has(source.ui.texture.kind) || !WORLD_UI_BLEND_MODES.has(source.ui.texture.blendMode)) {
    throw new TypeError(`unregistered ${source.profileId} UI texture`);
  }
  if (!WORLD_UI_EASINGS.has(source.ui.motion.easing)) {
    throw new TypeError(`unregistered ${source.profileId} UI easing`);
  }
  if (
    source.semanticChannels.provenance.join(':') !== 'hue:shape' ||
    source.semanticChannels.confirmation.join(':') !== 'hue:stroke' ||
    source.semanticChannels.focus.join(':') !== 'contrast:outline'
  ) {
    throw new TypeError(`protected semantic channels changed: ${source.profileId}`);
  }
}

/** Validate, derive semantic UI roles, and freeze one compiled profile. */
export function createWorldArtProfile(source: WorldArtProfileSource): WorldArtProfile {
  validateWorldArtProfileSource(source);
  const frozen = freezeSource(source);
  const colors = deriveWorldUiColors(frozen.palette);
  return Object.freeze({
    ...frozen,
    ui: Object.freeze({ ...frozen.ui, colors }),
  });
}

/** Fresh mutable copy used only inside the trusted capability compiler. */
export function copyWorldArtProfileSource(source: WorldArtProfileSource): WorldArtProfileSource {
  return {
    ...source,
    geometry: { ...source.geometry },
    material: { ...source.material },
    palette: { ...source.palette },
    semanticChannels: {
      provenance: [...source.semanticChannels.provenance],
      confirmation: [...source.semanticChannels.confirmation],
      focus: [...source.semanticChannels.focus],
    },
    ui: {
      typography: { ...source.ui.typography },
      material: { ...source.ui.material },
      texture: { ...source.ui.texture },
      motion: { ...source.ui.motion },
    },
  };
}

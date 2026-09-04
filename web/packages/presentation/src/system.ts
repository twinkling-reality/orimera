import type { ProvenanceClass } from '@exulanica/atlas-core';

export type PresentationThemeName = 'dawn' | 'blue-hour';
export type LightFieldRole = 'key' | 'crosslight' | 'afterimage' | 'bounce' | 'rim';

export interface DirectionalFieldStop {
  readonly offsetPct: number;
  readonly alpha: number;
}

export interface DirectionalLightPlane {
  readonly role: LightFieldRole;
  readonly angleDeg: number;
  readonly stops: readonly DirectionalFieldStop[];
}

export interface PresentationWorld {
  /** One full-field composition. Exposures relight these planes without moving them. */
  readonly field: readonly [
    DirectionalLightPlane,
    DirectionalLightPlane,
    DirectionalLightPlane,
    DirectionalLightPlane,
    DirectionalLightPlane,
  ];
  readonly material: {
    readonly labelRadius: 3;
    readonly panelRadius: 6;
    readonly pillRadius: 999;
    readonly worldBlur: 8;
    readonly systemBlur: 18;
  };
}

export type PresentationAtmosphere = Readonly<Record<LightFieldRole, string>>;

/** One exposure of the same Atlas world. Semantic roles do not move between exposures. */
export interface PresentationTheme {
  readonly name: PresentationThemeName;
  readonly colorScheme: 'light' | 'dark';
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
  readonly atmosphere: PresentationAtmosphere;
  readonly provenance: Readonly<Record<ProvenanceClass, string>>;
}

/** Geometry and material grammar are world identity, so they exist once rather than per theme. */
const plane = (
  role: LightFieldRole,
  angleDeg: number,
  stops: readonly (readonly [number, number])[],
): DirectionalLightPlane => Object.freeze({
  role,
  angleDeg,
  stops: Object.freeze(stops.map(([offsetPct, alpha]) => Object.freeze({ offsetPct, alpha }))),
});

export const EXULANICA_WORLD: PresentationWorld = Object.freeze({
  field: Object.freeze([
    plane('key', 118, [[-12, 0.42], [28, 0.24], [76, 0]]),
    plane('crosslight', 252, [[-8, 0.26], [34, 0.18], [72, 0]]),
    plane('afterimage', 18, [[4, 0], [34, 0.16], [58, 0.3], [78, 0.08], [96, 0]]),
    plane('bounce', 4, [[-8, 0.18], [34, 0.1], [72, 0]]),
    plane('rim', 154, [[30, 0], [66, 0.1], [110, 0.18]]),
  ] as const),
  material: Object.freeze({
    labelRadius: 3,
    panelRadius: 6,
    pillRadius: 999,
    worldBlur: 8,
    systemBlur: 18,
  }),
});


export const DAWN_THEME: PresentationTheme = Object.freeze({
  name: 'dawn',
  colorScheme: 'light',
  ground: '#dce5df',
  surface: '#eff1e9',
  raised: '#fbf8ee',
  ink: '#1b261f',
  body: '#3c493f',
  muted: '#58645c',
  accent: '#3e634d',
  secondary: '#a8783b',
  focus: '#2c5c45',
  warning: '#805724',
  error: '#99464b',
  atmosphere: Object.freeze({
    key: '#f1d394',
    crosslight: '#d6c2a5',
    afterimage: '#a8783b',
    bounce: '#bac7bc',
    rim: '#e8e0ce',
  }),
  provenance: Object.freeze({
    capture: '#2f6a5b',
    inference: '#57686d',
    user: '#805724',
    external: '#70586d',
  }),
});

export const BLUE_HOUR_THEME: PresentationTheme = Object.freeze({
  name: 'blue-hour',
  colorScheme: 'dark',
  ground: '#10151e',
  surface: '#19212e',
  raised: '#222c3a',
  ink: '#edf2fa',
  body: '#b2bdd0',
  muted: '#93a0b6',
  accent: '#85aeff',
  secondary: '#c1a3da',
  focus: '#91b9ff',
  warning: '#e2a45f',
  error: '#f0a0a8',
  atmosphere: Object.freeze({
    key: '#365579',
    crosslight: '#4a334f',
    afterimage: '#63452f',
    bounce: '#2e514a',
    rim: '#44365f',
  }),
  provenance: Object.freeze({
    capture: '#91c6d8',
    inference: '#a1b0dd',
    user: '#e2be79',
    external: '#c8acd1',
  }),
});

export const PRESENTATION_THEMES: Readonly<Record<PresentationThemeName, PresentationTheme>> =
  Object.freeze({ dawn: DAWN_THEME, 'blue-hour': BLUE_HOUR_THEME });

function channels(hex: string): readonly [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new TypeError(`expected a six-digit hex colour, got ${hex}`);
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export function unitRgb(hex: string): readonly [number, number, number] {
  const [r, g, b] = channels(hex);
  return [r / 255, g / 255, b / 255];
}

export function byteRgba(hex: string, alpha: number): readonly [number, number, number, number] {
  const [r, g, b] = channels(hex);
  return [r, g, b, Math.round(Math.max(0, Math.min(1, alpha)) * 255)];
}

/** vec4 array consumed by the point-map shader: RGB plus stable semantic tint strength. */
export function pointProvenancePalette(theme: PresentationTheme): Float32Array {
  const out = new Float32Array(16);
  const entries: readonly (readonly [ProvenanceClass, number])[] = [
    ['capture', 0.15],
    ['inference', 0.55],
    ['user', 0.5],
    ['external', 0.65],
  ];
  entries.forEach(([kind, strength], index) => {
    const [r, g, b] = unitRgb(theme.provenance[kind]);
    out.set([r, g, b, strength], index * 4);
  });
  return out;
}

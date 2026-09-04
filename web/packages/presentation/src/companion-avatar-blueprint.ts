/**
 * Renderer-neutral geometry for the V3 Companion.
 *
 * The configuration remains the public, versioned preference contract. This file is the small
 * visual blueprint that lets more than one DOM/SVG surface render that contract without copying
 * paths or eye poses. It deliberately contains no DOM, animation, storage, or renderer policy.
 */

import type {
  CompanionAppearanceConfiguration,
  CompanionBodyVariant,
  CompanionFaceVariant,
} from './companion-appearance.js';

export type CompanionEyeShape = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
];

export interface CompanionEyePose {
  readonly left: CompanionEyeShape;
  readonly right: CompanionEyeShape;
}

const BODY_PATHS: Readonly<Record<CompanionBodyVariant, string>> = Object.freeze({
  circle: 'M120 20C175.23 20 220 64.77 220 120S175.23 220 120 220 20 175.23 20 120 64.77 20 120 20Z',
  pebble: 'M120 23C178 23 215 57 215 112C215 173 181 216 120 216C58 216 24 178 24 119C24 60 62 23 120 23Z',
  squircle: 'M78 22H162C197 22 218 43 218 78V162C218 197 197 218 162 218H78C43 218 22 197 22 162V78C22 43 43 22 78 22Z',
  capsule: 'M120 15C165 15 194 48 194 93V147C194 192 165 225 120 225C75 225 46 192 46 147V93C46 48 75 15 120 15Z',
  cloud: 'M70 205C39 205 20 184 20 155C20 131 33 112 55 106C49 70 71 38 106 38C127 38 144 47 155 64C164 58 176 55 188 58C211 64 224 86 219 109C234 121 240 141 234 160C227 187 205 205 176 205Z',
  droplet: 'M120 13C139 48 195 91 195 145C195 190 163 221 120 221C77 221 45 190 45 145C45 91 101 48 120 13Z',
});

const EYE_POSES: Readonly<Record<CompanionFaceVariant, CompanionEyePose>> = Object.freeze({
  neutral: { left: [82, 78, 15, 39, -24], right: [132, 70, 15, 39, -24] },
  attentive: { left: [76, 72, 21, 48, 8], right: [139, 72, 21, 48, 8] },
  curious: { left: [79, 75, 18, 43, -18], right: [137, 65, 23, 52, -18] },
  happy: { left: [80, 89, 22, 12, 22], right: [137, 89, 22, 12, -22] },
  sleepy: { left: [79, 91, 24, 9, -8], right: [137, 91, 24, 9, 8] },
});

export interface CompanionAvatarBlueprint {
  readonly viewBox: '0 0 240 240';
  readonly bodyPath: string;
  readonly eyePose: CompanionEyePose;
}

export function companionAvatarBlueprint(
  configuration: CompanionAppearanceConfiguration,
): CompanionAvatarBlueprint {
  return Object.freeze({
    viewBox: '0 0 240 240',
    bodyPath: BODY_PATHS[configuration.bodyVariant],
    eyePose: EYE_POSES[configuration.faceVariant],
  });
}

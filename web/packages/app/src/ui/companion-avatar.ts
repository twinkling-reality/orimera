import {
  DEFAULT_COMPANION,
  type CompanionAppearanceConfiguration,
  type CompanionFaceVariant,
} from '@orimera/presentation';

const SVG_NS = 'http://www.w3.org/2000/svg';

const BODY_PATHS = Object.freeze({
  circle: 'M120 20C175.23 20 220 64.77 220 120S175.23 220 120 220 20 175.23 20 120 64.77 20 120 20Z',
  pebble: 'M120 23C178 23 215 57 215 112C215 173 181 216 120 216C58 216 24 178 24 119C24 60 62 23 120 23Z',
  squircle: 'M78 22H162C197 22 218 43 218 78V162C218 197 197 218 162 218H78C43 218 22 197 22 162V78C22 43 43 22 78 22Z',
  capsule: 'M120 15C165 15 194 48 194 93V147C194 192 165 225 120 225C75 225 46 192 46 147V93C46 48 75 15 120 15Z',
  cloud: 'M70 205C39 205 20 184 20 155C20 131 33 112 55 106C49 70 71 38 106 38C127 38 144 47 155 64C164 58 176 55 188 58C211 64 224 86 219 109C234 121 240 141 234 160C227 187 205 205 176 205Z',
  droplet: 'M120 13C139 48 195 91 195 145C195 190 163 221 120 221C77 221 45 190 45 145C45 91 101 48 120 13Z',
});

interface EyePose {
  readonly left: readonly [number, number, number, number, number];
  readonly right: readonly [number, number, number, number, number];
}

const EYE_POSES: Readonly<Record<CompanionFaceVariant, EyePose>> = Object.freeze({
  neutral: { left: [82, 78, 15, 39, -24], right: [132, 70, 15, 39, -24] },
  attentive: { left: [76, 72, 21, 48, 8], right: [139, 72, 21, 48, 8] },
  curious: { left: [79, 75, 18, 43, -18], right: [137, 65, 23, 52, -18] },
  happy: { left: [80, 89, 22, 12, 22], right: [137, 89, 22, 12, -22] },
  sleepy: { left: [79, 91, 24, 9, -8], right: [137, 91, 24, 9, 8] },
});

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function applyEyePose(left: SVGRectElement, right: SVGRectElement, pose: EyePose): void {
  const apply = (eye: SVGRectElement, values: EyePose['left']): void => {
    const [x, y, width, height, rotation] = values;
    eye.setAttribute('x', String(x));
    eye.setAttribute('y', String(y));
    eye.setAttribute('width', String(width));
    eye.setAttribute('height', String(height));
    eye.setAttribute('rx', String(width / 2));
    eye.setAttribute('transform', `rotate(${rotation} ${x + width / 2} ${y + height / 2})`);
  };
  apply(left, pose.left);
  apply(right, pose.right);
}

export interface CompanionAvatar {
  readonly root: SVGSVGElement;
  readonly gaze: SVGGElement;
  setAppearance(configuration: CompanionAppearanceConfiguration): void;
}

/** One geometric renderer shared by the live presence and its persistent workshop preview. */
export function createCompanionAvatar(
  initial: CompanionAppearanceConfiguration = DEFAULT_COMPANION,
): CompanionAvatar {
  const root = svgElement('svg', {
    class: 'companion-avatar', viewBox: '0 0 240 240', 'aria-hidden': 'true',
  });
  const orb = svgElement('g', { class: 'companion-avatar-orb' });
  const body = svgElement('path', { class: 'companion-avatar-body' });
  const gaze = svgElement('g', { class: 'companion-avatar-gaze' });
  const leftBlink = svgElement('g', { class: 'companion-avatar-blink companion-avatar-blink-left' });
  const rightBlink = svgElement('g', { class: 'companion-avatar-blink companion-avatar-blink-right' });
  const leftEye = svgElement('rect', { class: 'companion-avatar-eye' });
  const rightEye = svgElement('rect', { class: 'companion-avatar-eye' });
  leftBlink.append(leftEye);
  rightBlink.append(rightEye);
  gaze.append(leftBlink, rightBlink);
  orb.append(body, gaze);

  const thinking = svgElement('g', { class: 'companion-avatar-thinking' });
  for (let index = 0; index < 3; index += 1) {
    thinking.append(svgElement('circle', {
      class: `companion-avatar-dot companion-avatar-dot-${index + 1}`,
      cx: String(78 + index * 42), cy: '120', r: index === 1 ? '17' : '13',
    }));
  }
  root.append(orb, thinking);

  const setAppearance = (next: CompanionAppearanceConfiguration): void => {
    body.setAttribute('d', BODY_PATHS[next.bodyVariant]);
    body.setAttribute('fill', next.bodyColor);
    for (const dot of thinking.querySelectorAll<SVGCircleElement>('circle')) dot.setAttribute('fill', next.bodyColor);
    leftEye.setAttribute('fill', next.eyeColor);
    rightEye.setAttribute('fill', next.eyeColor);
    applyEyePose(leftEye, rightEye, EYE_POSES[next.faceVariant]);
  };
  setAppearance(initial);
  return { root, gaze, setAppearance };
}

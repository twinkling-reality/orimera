import {
  companionAvatarBlueprint,
  DEFAULT_COMPANION,
  type CompanionAppearanceConfiguration,
  type CompanionEyePose,
} from '@exulanica/presentation';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function applyEyePose(left: SVGRectElement, right: SVGRectElement, pose: CompanionEyePose): void {
  const apply = (eye: SVGRectElement, values: CompanionEyePose['left']): void => {
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
    const blueprint = companionAvatarBlueprint(next);
    body.setAttribute('d', blueprint.bodyPath);
    body.setAttribute('fill', next.bodyColor);
    for (const dot of thinking.querySelectorAll<SVGCircleElement>('circle')) dot.setAttribute('fill', next.bodyColor);
    leftEye.setAttribute('fill', next.eyeColor);
    rightEye.setAttribute('fill', next.eyeColor);
    applyEyePose(leftEye, rightEye, blueprint.eyePose);
  };
  setAppearance(initial);
  return { root, gaze, setAppearance };
}

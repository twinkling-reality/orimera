/** A decorative micro-render of the shared Companion blueprint for title-menu wayfinding. */

import {
  companionAvatarBlueprint,
  DEFAULT_COMPANION,
  type CompanionEyeShape,
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

function eye(values: CompanionEyeShape, color: string): SVGRectElement {
  const [x, y, width, height, rotation] = values;
  return svgElement('rect', {
    class: 'companion-menu-eye',
    x: String(x),
    y: String(y),
    width: String(width),
    height: String(height),
    rx: String(width / 2),
    fill: color,
    transform: `rotate(${rotation} ${x + width / 2} ${y + height / 2})`,
  });
}

export function createCompanionMenuMarker(): SVGSVGElement {
  const appearance = DEFAULT_COMPANION;
  const blueprint = companionAvatarBlueprint(appearance);
  const root = svgElement('svg', {
    class: 'companion-menu-marker',
    viewBox: blueprint.viewBox,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const gradientId = 'companion-menu-wake-gradient';
  const gradient = svgElement('linearGradient', {
    id: gradientId,
    x1: '0%',
    y1: '12%',
    x2: '100%',
    y2: '88%',
  });
  gradient.append(
    svgElement('stop', { offset: '0%', 'stop-color': '#d9ff73', 'stop-opacity': '0.3' }),
    svgElement('stop', { offset: '54%', 'stop-color': '#cfe4ff' }),
    svgElement('stop', { offset: '100%', 'stop-color': '#ddd7ff', 'stop-opacity': '0.65' }),
  );
  const definitions = svgElement('defs');
  definitions.append(gradient);
  const wake = svgElement('ellipse', {
    class: 'companion-menu-wake',
    cx: '120',
    cy: '120',
    rx: '180',
    ry: '80',
    fill: `url(#${gradientId})`,
  });
  const orb = svgElement('g', { class: 'companion-menu-orb' });
  orb.append(
    svgElement('path', {
      class: 'companion-menu-body',
      d: blueprint.bodyPath,
      fill: appearance.bodyColor,
    }),
    svgElement('g', { class: 'companion-menu-gaze' }),
  );
  orb.lastElementChild?.append(
    eye(blueprint.eyePose.left, appearance.eyeColor),
    eye(blueprint.eyePose.right, appearance.eyeColor),
  );
  root.append(definitions, wake, orb);
  root.dataset['state'] = 'resting';
  return root;
}

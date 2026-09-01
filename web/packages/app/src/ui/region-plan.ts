import { el } from './dom.js';

/**
 * A plan of the world's regions, at the size of a thumbnail.
 *
 * Two surfaces need the same picture for different reasons. The Index needs it to answer "which
 * two regions", because "2 regions" on a row is otherwise a number taken on trust. Traversal
 * needs it to answer "where am I", and it must answer that WITHOUT a second rendering of the
 * world: this is an SVG of the same placements the renderer reads, so it costs no camera, no
 * render target, and nothing per frame beyond moving one marker.
 *
 * It is drawn to relative scale and carries no scale bar and no compass, because the question is
 * "where, relative to the rest of this" and never "how far in metres". A world that has to be
 * navigated by a coordinate readout is a world that failed to be navigable.
 */

const SVG = 'http://www.w3.org/2000/svg';

export interface RegionPoint {
  readonly islandId: string;
  readonly x: number;
  readonly z: number;
}

/** Where the viewer stands and which way they face, in the same Atlas coordinates. */
export interface ViewerPose {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export interface RegionPlan {
  readonly root: HTMLElement;
  /** Light the regions in `active`. `label` names what they belong to, for the readout. */
  render(active: ReadonlySet<string>, label: string | null): void;
  /** Place the viewer. Null removes the marker, for surfaces that do not track a camera. */
  setViewer(pose: ViewerPose | null): void;
}

export interface RegionPlanOptions {
  /** A short caption above the figure. Omitted, the plan is only the figure and its readout. */
  readonly title?: string;
  /** Whether to draw the "you are here" marker at all. */
  readonly viewer?: boolean;
  readonly className?: string;
}

export function buildRegionPlan(
  regions: readonly RegionPoint[],
  options: RegionPlanOptions = {},
): RegionPlan {
  const root = el('aside', {
    class: options.className ?? 'index-plan',
    'aria-label': 'Region plan',
  });
  if (regions.length === 0) {
    root.hidden = true;
    return { root, render() {}, setViewer() {} };
  }

  const caption = el('p', { class: 'index-plan-caption' });
  const readout = el('p', { class: 'index-plan-readout', 'aria-live': 'polite' });
  const xs = regions.map((region) => region.x);
  const zs = regions.map((region) => region.z);
  /*
   * One span for both axes. A single region, or a perfectly collinear set, must not divide by
   * zero, and must not be stretched to fill the box either: separate spans per axis would make
   * two regions a hand's width apart look as far apart as two across the whole field.
   */
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...zs) - Math.min(...zs),
    1,
  );
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const midZ = (Math.max(...zs) + Math.min(...zs)) / 2;
  const project = (value: number, mid: number): number => 50 + ((value - mid) / span) * 78;

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'index-plan-figure');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-hidden', 'true');

  const dots = new Map<string, SVGCircleElement>();
  for (const region of regions) {
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', project(region.x, midX).toFixed(2));
    dot.setAttribute('cy', project(region.z, midZ).toFixed(2));
    dot.setAttribute('r', '3.4');
    dot.setAttribute('class', 'index-plan-dot');
    svg.append(dot);
    dots.set(region.islandId, dot);
  }

  // A wedge rather than a dot: standing somewhere is half the answer, facing is the other half.
  const viewer = options.viewer === true ? document.createElementNS(SVG, 'path') : null;
  if (viewer !== null) {
    viewer.setAttribute('d', 'M 0 -5.4 L 3.6 4.2 L 0 2.2 L -3.6 4.2 Z');
    viewer.setAttribute('class', 'index-plan-viewer');
    viewer.setAttribute('visibility', 'hidden');
    svg.append(viewer);
  }

  root.append(
    ...(options.title === undefined
      ? []
      : [el('p', { class: 'index-section-label', text: options.title })]),
    svg,
    caption,
    readout,
  );

  return {
    root,
    render(active, label) {
      for (const [islandId, dot] of dots) {
        dot.dataset['active'] = active.has(islandId) ? 'true' : 'false';
      }
      caption.textContent = active.size === 0
        ? `${regions.length} ${regions.length === 1 ? 'region' : 'regions'}`
        : `${active.size} of ${regions.length}`;
      readout.textContent = active.size === 0
        ? 'Select an entry to place it.'
        : `${label ?? 'This entry'} appears in the marked regions.`;
    },
    setViewer(pose) {
      if (viewer === null) return;
      if (pose === null) {
        viewer.setAttribute('visibility', 'hidden');
        return;
      }
      const x = project(pose.x, midX);
      const y = project(pose.z, midZ);
      /*
       * The wedge points up at rotation zero, and Atlas yaw zero faces -z, which the projection
       * puts at the top of the plan. Those agree. The SIGN does not: SVG rotates clockwise for
       * positive degrees, while a positive Atlas yaw swings the forward vector toward -x, which
       * is leftward here. Hence the negation, which is the whole of the correction.
       *
       * The marker is allowed outside the 0..100 box. Walking past the outermost region should
       * show you leaving, not pin you to the edge and imply you never left.
       */
      const degrees = (-pose.yaw * 180) / Math.PI;
      viewer.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${degrees.toFixed(1)})`);
      viewer.setAttribute('visibility', 'visible');
    },
  };
}

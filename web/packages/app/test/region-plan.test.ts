// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildRegionPlan, type RegionPoint } from '../src/ui/region-plan.js';

/** Two regions on the x axis, so the centre of the pair is the origin and the span is 20. */
const PAIR: readonly RegionPoint[] = [
  { islandId: 'a', x: -10, z: 0 },
  { islandId: 'b', x: 10, z: 0 },
];

const viewerOf = (root: HTMLElement): SVGPathElement =>
  root.querySelector<SVGPathElement>('.index-plan-viewer')!;

const transformOf = (root: HTMLElement): string =>
  viewerOf(root).getAttribute('transform') ?? '';

describe('region plan', () => {
  it('draws one dot per region', () => {
    const plan = buildRegionPlan(PAIR);
    expect(plan.root.querySelectorAll('.index-plan-dot')).toHaveLength(2);
  });

  it('omits the viewer entirely unless asked for one', () => {
    const plan = buildRegionPlan(PAIR);
    expect(plan.root.querySelector('.index-plan-viewer')).toBeNull();
    // A surface with no camera must be able to call this without consequence.
    expect(() => plan.setViewer({ x: 0, z: 0, yaw: 0 })).not.toThrow();
  });

  it('keeps the viewer hidden until it is placed', () => {
    const plan = buildRegionPlan(PAIR, { viewer: true });
    expect(viewerOf(plan.root).getAttribute('visibility')).toBe('hidden');
  });

  it('puts a viewer at the centre of the field in the middle of the plan', () => {
    const plan = buildRegionPlan(PAIR, { viewer: true });
    plan.setViewer({ x: 0, z: 0, yaw: 0 });
    expect(viewerOf(plan.root).getAttribute('visibility')).toBe('visible');
    expect(transformOf(plan.root)).toContain('translate(50.00 50.00)');
  });

  /*
   * The correction that is easy to get backwards and impossible to see in a test suite that only
   * checks the marker exists. Atlas yaw zero faces -z, which the projection puts at the top of
   * the plan, and the wedge points up unrotated: those agree. A POSITIVE yaw swings the forward
   * vector toward -x, which is leftward here, while SVG rotates clockwise for positive degrees.
   * So the plan's rotation is the negation of the yaw, and a quarter turn left proves it.
   */
  it('turns the viewer the same way the world turns', () => {
    const plan = buildRegionPlan(PAIR, { viewer: true });
    plan.setViewer({ x: 0, z: 0, yaw: 0 });
    expect(transformOf(plan.root)).toContain('rotate(0.0)');
    plan.setViewer({ x: 0, z: 0, yaw: Math.PI / 2 });
    expect(transformOf(plan.root)).toContain('rotate(-90.0)');
    plan.setViewer({ x: 0, z: 0, yaw: -Math.PI / 2 });
    expect(transformOf(plan.root)).toContain('rotate(90.0)');
  });

  it('places east and south where the field puts them', () => {
    const plan = buildRegionPlan(PAIR, { viewer: true });
    plan.setViewer({ x: 10, z: 0, yaw: 0 });
    expect(transformOf(plan.root)).toContain('translate(89.00 50.00)');
    plan.setViewer({ x: 0, z: 10, yaw: 0 });
    expect(transformOf(plan.root)).toContain('translate(50.00 89.00)');
  });

  /* Walking past the outermost region should read as leaving, not as being pinned to the edge. */
  it('lets the viewer leave the plotted field', () => {
    const plan = buildRegionPlan(PAIR, { viewer: true });
    plan.setViewer({ x: 40, z: 0, yaw: 0 });
    expect(transformOf(plan.root)).toContain('translate(206.00 50.00)');
  });

  it('hides the viewer again when there is no pose', () => {
    const plan = buildRegionPlan(PAIR, { viewer: true });
    plan.setViewer({ x: 0, z: 0, yaw: 0 });
    plan.setViewer(null);
    expect(viewerOf(plan.root).getAttribute('visibility')).toBe('hidden');
  });

  /* A single region has no span. It must not divide by zero or fly off the plan. */
  it('survives a field with one region', () => {
    const plan = buildRegionPlan([{ islandId: 'only', x: 5, z: -3 }], { viewer: true });
    plan.setViewer({ x: 5, z: -3, yaw: 0 });
    expect(transformOf(plan.root)).toContain('translate(50.00 50.00)');
  });

  it('reports how many regions an entry occupies', () => {
    const plan = buildRegionPlan(PAIR);
    plan.render(new Set(), null);
    expect(plan.root.textContent).toContain('2 regions');
    plan.render(new Set(['a']), 'Mara');
    expect(plan.root.textContent).toContain('1 of 2');
    expect(plan.root.textContent).toContain('Mara');
  });

  it('hides itself rather than drawing an empty field', () => {
    const plan = buildRegionPlan([]);
    expect(plan.root.hidden).toBe(true);
  });
});

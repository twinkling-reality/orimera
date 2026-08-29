import type { MoteState } from './companion-motes.js';
import { createMoteField } from './companion-motes.js';

/**
 * The Companion's body: one field of motes on its own 2D canvas, over the world.
 *
 * **Why this and not the alternatives.** Four were built and compared in place against the real
 * Atlas: this, a mesh gradient orb, an aperture, a constellation, and the authored Spline robot as
 * a control. The robot lost on a product argument rather than a visual one, and it is the argument
 * worth keeping: it has a face, and faces make claims. A character that beams when you confirm a
 * relative is expressing a feeling about your family, which is warmth the system has not earned at
 * roughly 60% identification accuracy. The gradient orb lost for being the category's house style,
 * handsome and interchangeable with every other AI product's.
 *
 * The motes won because they are the Atlas's own substance. Every region, photograph and anchor in
 * this product is a point cloud, so a Companion made of the same material is made OF the memories
 * rather than imported into them, and it is the one form here that could not be lifted onto
 * somebody else's product tomorrow.
 *
 * **Rendered in 2D, deliberately.** The Atlas owns a WebGL context and this does not need a second
 * one. Nothing here reads the point map, the islands or the anchors.
 */

export interface CompanionStageOptions {
  readonly parent: HTMLElement;
}

export interface CompanionStage {
  readonly root: HTMLElement;
  /** The Companion's box on screen, for a panel to sit under or beside. */
  screenBox(): DOMRect | null;
  show(): void;
  hide(): void;
  visible(): boolean;
  state(): MoteState;
  setState(next: MoteState): void;
  dispose(): void;
}

export function buildCompanionStage(options: CompanionStageOptions): CompanionStage {
  const root = document.createElement('div');
  root.className = 'companion-stage';
  root.setAttribute('aria-hidden', 'true');

  const canvas = document.createElement('canvas');
  canvas.className = 'companion-flat';
  root.append(canvas);
  options.parent.append(root);

  const field = createMoteField();
  let shown = false;
  let raf = 0;
  let last = 0;

  const size = (): void => {
    const rect = root.getBoundingClientRect();
    const side = Math.max(1, Math.round(Math.min(rect.width, rect.height) * window.devicePixelRatio));
    canvas.width = side;
    canvas.height = side;
  };
  size();
  window.addEventListener('resize', size);
  // Measured whenever the box actually changes, not once at construction. Sizing before layout
  // floors the canvas at one pixel, and CSS then stretches that pixel across the whole box: the
  // symptom is a solid rectangle of colour that looks like a broken asset rather than a bad
  // measurement. Cost an hour once already.
  const observer = new ResizeObserver(() => size());
  observer.observe(root);

  function tick(ms: number): void {
    raf = window.requestAnimationFrame(tick);
    // Clamped: a backgrounded tab resumes with a delta of many seconds, and an unclamped step
    // would finish every transition in one frame, which is the animation missed rather than
    // merely rushed.
    const dt = last === 0 ? 0.016 : Math.min(0.05, (ms - last) / 1000);
    last = ms;
    if (!shown) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    field.update(dt);
    field.draw(ctx, canvas.width);
  }
  raf = window.requestAnimationFrame(tick);

  return {
    root,
    visible: () => shown,
    state: () => field.state(),
    setState(next) {
      field.setState(next);
    },
    show() {
      shown = true;
      root.setAttribute('data-shown', 'true');
      // The box may have had no size while hidden, so measure it now it has one.
      size();
    },
    hide() {
      shown = false;
      root.removeAttribute('data-shown');
    },
    screenBox() {
      if (!shown) return null;
      return root.getBoundingClientRect();
    },
    dispose() {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', size);
      root.remove();
    },
  };
}

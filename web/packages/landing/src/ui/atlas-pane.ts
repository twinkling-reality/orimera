/**
 * What the entrance arrives at: an unformed Atlas.
 *
 * It is unformed because nothing has been processed. A signed-out page that showed three
 * photoreal regions would be claiming a world it does not have, and the demo-honesty rules in
 * product-specification.md 4.1 rule that out explicitly. What it shows instead is the space, the
 * caption that governs it, and a capture forming inside it.
 */

import { el } from './dom.js';

/**
 * What the visitor arrived at, which changes what the pane may truthfully say. An empty Atlas and
 * a pre-ingested sample are different claims and get different sentences.
 */
export type Arrival = 'empty' | 'sample';

export interface AtlasPaneHandles {
  readonly root: HTMLElement;
  setArrival(arrival: Arrival): void;
  /**
   * Under reduced motion the entrance is a cross-fade rather than a move, so the information the
   * movement carried has to be restated in words. interaction-model.md section 9 makes this
   * mandatory rather than nice: "Locate travel: a short cross-fade cut... An arrival caption."
   */
  setArrivalCaption(text: string | null): void;
}

const ARRIVAL_COPY: Readonly<Record<Arrival, { eyebrow: string; lede: string }>> = Object.freeze({
  empty: {
    eyebrow: 'Unformed Atlas',
    lede:
      'Nothing has been uploaded here. This is the space a capture forms into, and it is the same space you would be standing in afterwards. There is no second scene to load.',
  },
  // product-specification.md 4.1: pre-ingested captures are acceptable and must be disclosed on
  // the page itself. This is that disclosure, and it is in the first paragraph rather than a
  // footnote.
  sample: {
    eyebrow: 'Sample world, pre-ingested',
    lede:
      'This region was not processed just now. It is a scripted replay of one capture forming, shown so the states and their labels can be read end to end. No live pipeline is running behind this page.',
  },
});

export function buildAtlasPane(onLeave: () => void, consoleRoot: HTMLElement): AtlasPaneHandles {
  // `tabindex="-1"` so the entrance can move focus to the pane it arrived at. Without it the
  // keyboard user is left behind on a button that is now hidden.
  const root = el('section', {
    id: 'atlas',
    class: 'pane pane-atlas',
    tabindex: '-1',
    'aria-label': 'Unformed Atlas',
  });

  const arrival = el('p', { class: 'arrival' });
  arrival.hidden = true;

  const lede = el('p', { class: 'atlas-lede' });
  const eyebrow = el('p', { class: 'eyebrow' });

  const back = el('button', { type: 'button', class: 'ghost', text: 'Back to the landing page' });
  back.addEventListener('click', onLeave);

  root.append(
    el('header', { class: 'atlas-head' }, [eyebrow, lede, arrival]),
    consoleRoot,
    el('footer', { class: 'atlas-foot' }, [
      // Never dismissible. interaction-model.md 6.2 fixes this sentence to the Atlas Map, and it
      // is the user-facing half of the coordinate rule in 1.2. It is true here too, so it is here.
      el('p', {
        class: 'standing-caption',
        text: 'Positions show how these memories relate, not where they happened.',
      }),
      back,
    ]),
  );

  return {
    root,
    setArrival(arrival) {
      const copy = ARRIVAL_COPY[arrival];
      eyebrow.textContent = copy.eyebrow;
      lede.textContent = copy.lede;
      root.setAttribute('aria-label', copy.eyebrow);
    },
    setArrivalCaption(text) {
      arrival.textContent = text ?? '';
      arrival.hidden = text === null;
    },
  };
}

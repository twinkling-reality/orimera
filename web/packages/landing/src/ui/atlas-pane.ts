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
 * WHAT THE ATLAS CONTAINS, not how the visitor got here.
 *
 * This used to be an arrival mode: the whole session was flagged `empty` or `sample`, and the
 * pane said "Sample world, pre-ingested" across everything in it. That was wrong on the product's
 * own terms. interaction-model.md 1.1 has one scene for the whole session, so there is no such
 * thing as a sample world to arrive in; there are only regions in the Atlas, some of which happen
 * to be samples. A visitor with three captures of their own and two samples was, under the old
 * model, in an unnameable mixed state.
 *
 * So the pane now says only whether anything is here. Whether a given region is a sample is
 * carried by that region, next to the rung it earned, which is where a reader can act on it.
 */
export type Arrival = 'empty' | 'populated';

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
  populated: {
    eyebrow: 'Atlas',
    lede:
      'One region is placed here. Regions sit in the same continuous space whatever they came from, and each one states its own origin and the reconstruction rung it earned rather than leaving you to infer either.',
  },
});

export function buildAtlasPane(onLeave: () => void, consoleRoot: HTMLElement): AtlasPaneHandles {
  // `tabindex="-1"` so the entrance can move focus to the pane it arrived at. Without it the
  // keyboard user is left behind on a button that is now hidden.
  const root = el('section', {
    id: 'atlas',
    class: 'pane pane-atlas',
    tabindex: '-1',
    'aria-label': 'Atlas',
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

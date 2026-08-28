/**
 * The signed-out landing surface.
 *
 * Copy discipline, because this page is a claim surface and product-specification.md section 6
 * and section 7 constrain it directly:
 *
 *   - The words "immutable", "WORM" and "tamper-proof" are banned. The supportable phrase is
 *     "append-only by policy" (6.1).
 *   - No claim about voices, speech, conversations or transcripts appears anywhere, including
 *     marketing surfaces (2.3). This page is a marketing surface.
 *   - No completion metric, no urgency, no streaks (7).
 *   - No claim of on-device or local-only processing (7). The page says the opposite, plainly.
 */

import { rungProperties, type ProvenanceClass, type ReconstructionRung } from '@orimera/atlas-core';
import { rungSentence } from '../formation/index.js';
import { el } from './dom.js';

export interface LandingPaths {
  onEnter(): void;
  onSample(): void;
  onHowItWorks(): void;
}

export const REPOSITORY_URL = 'https://github.com/twinkling-reality/orimera';

/** The four provenance classes, which must be visually distinguishable wherever they appear. */
const PROVENANCE: readonly { readonly cls: ProvenanceClass; readonly label: string; readonly gloss: string }[] = [
  { cls: 'capture', label: 'Capture supported', gloss: 'A deterministic property of the photograph itself.' },
  { cls: 'inference', label: 'Model inferred', gloss: 'Any model output, however confident. A detection is an inference.' },
  { cls: 'user', label: 'You told me', gloss: 'Stated by you. The only class allowed to write a name.' },
  { cls: 'external', label: 'External web', gloss: 'An opt-in public lookup. It can never be cited as evidence.' },
];

export function buildLanding(paths: LandingPaths): HTMLElement {
  const root = el('main', { id: 'landing', class: 'pane pane-landing' });

  root.append(
    el('p', { class: 'eyebrow', text: 'Personal world memory model' }),
    el('h1', { class: 'display' }, [
      'A memory you can walk through, ',
      el('em', { text: 'and check' }),
      '.',
    ]),
    el('p', {
      class: 'lede',
      text:
        'Orimera turns a photograph library into navigable memory regions inside one continuous space. Recurring people, places and objects link across them, and every historical claim opens the exact photograph it came from.',
    }),
  );

  const commitments = el('ul', { class: 'commitments' });
  for (const [strong, rest] of [
    ['Evidence is the product.', 'Geometry is the presentation. A claim resolves to captured bytes, never to reconstructed geometry.'],
    ['It may organise on a guess.', 'It never asserts on one. An automatic identity link can light the world up. It cannot support a sentence until you confirm it.'],
    ['Uncertainty is shown.', 'The reconstruction rung a region earned, the provenance of every field, and the questions it cannot answer are all visible.'],
  ] as const) {
    commitments.append(el('li', {}, [el('strong', { text: strong }), ' ', rest]));
  }
  root.append(commitments);

  const nav = el('nav', { class: 'paths', 'aria-label': 'Primary' });
  nav.append(
    action('enter', 'Enter Orimera', 'Move into an empty Atlas', paths.onEnter, true),
    action('sample', 'Explore a sample world', 'Pre-ingested, and labelled as such', paths.onSample, false),
    action('how', 'How it works', 'Four steps and the four provenance classes', paths.onHowItWorks, false),
  );
  const repo = el('a', {
    class: 'path',
    href: REPOSITORY_URL,
    rel: 'noreferrer',
  }, [el('span', { class: 'path-label', text: 'GitHub' }), el('span', { class: 'path-sub', text: 'Apache-2.0, and the documents this page is built from' })]);
  nav.append(repo);
  root.append(nav);

  root.append(
    el('p', {
      class: 'footnote',
      text:
        'Photographs are processed by third party cloud services. Orimera makes no on-device or local-only claim. Originals are retained append-only by policy.',
    }),
  );

  root.append(buildHowItWorks());
  return root;
}

function action(
  id: string,
  label: string,
  sub: string,
  onClick: () => void,
  primary: boolean,
): HTMLElement {
  const b = el('button', {
    type: 'button',
    class: primary ? 'path path-primary' : 'path',
    id: `path-${id}`,
  }, [el('span', { class: 'path-label', text: label }), el('span', { class: 'path-sub', text: sub })]);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * How it works, as an inline disclosure rather than a second page.
 *
 * Inline because a route change would tear down the canvas, and the whole point of the field is
 * that it is never torn down. It is a `details` element so it works with no JavaScript beyond
 * this file and is keyboard operable for free.
 */
function buildHowItWorks(): HTMLElement {
  const box = el('details', { id: 'how-it-works', class: 'how' });
  box.append(el('summary', { text: 'How it works' }));

  const steps = el('ol', { class: 'steps' });
  for (const [title, body] of [
    ['A capture becomes a region', 'A set of photographs becomes one navigable region placed inside a single continuous Atlas. Its position in the Atlas shows how it relates to your other memories. It never shows where the photographs were taken.'],
    ['Recurrence is proposed, not asserted', 'A person, place or object seen across separate captures is offered as a candidate. Open-set face identification is not accurate enough to assert an identity, so it does not. The proposal can light the world up. It cannot answer a question.'],
    ['You confirm, reject, or say you are not sure', '"Not sure" is recorded as data rather than as a blank, and skipping costs nothing. Every answer becomes a proposal you can see before it is committed, and nothing is written without one.'],
    ['Every claim opens its photograph', 'A citation opens the exact source image, and the anchor in the world pulses at the same time. If the evidence does not support an answer, the answer is a refusal with a stated reason.'],
  ] as const) {
    steps.append(el('li', {}, [el('h3', { text: title }), el('p', { text: body })]));
  }
  box.append(steps);

  box.append(el('h3', { class: 'sub-head', text: 'Four kinds of knowing, kept apart' }));
  const chips = el('ul', { class: 'provenance' });
  for (const p of PROVENANCE) {
    chips.append(
      el('li', { class: `prov prov-${p.cls}` }, [
        el('span', { class: 'prov-mark', 'aria-hidden': 'true' }),
        el('span', { class: 'prov-label', text: p.label }),
        el('span', { class: 'prov-gloss', text: p.gloss }),
      ]),
    );
  }
  box.append(chips);

  box.append(el('h3', { class: 'sub-head', text: 'The rung a region earned is displayed' }));
  box.append(
    el('p', {
      class: 'body',
      text:
        'Reconstruction from a small number of photographs often only partly succeeds. Rather than presenting whatever came out as if it were a room, each region states what it actually is and what you can do inside it.',
    }),
  );
  const rungs = el('ol', { class: 'rungs' });
  for (const rung of [1, 2, 3, 4] as const) {
    rungs.append(
      el('li', { class: rungProperties(rung).impliesFreeMovement ? 'rung rung-free' : 'rung' }, [
        el('span', { class: 'rung-n', text: `Rung ${rung}` }),
        el('span', { class: 'rung-copy', text: rungSentence(rung as ReconstructionRung) }),
      ]),
    );
  }
  box.append(rungs);
  return box;
}

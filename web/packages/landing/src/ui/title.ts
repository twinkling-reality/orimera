/**
 * The title screen.
 *
 * Copy discipline, because this is a claim surface and product-specification.md sections 6 and 7
 * constrain it directly:
 *
 *   - The words "immutable", "WORM" and "tamper-proof" are banned. The supportable phrase is
 *     "append-only by policy" (6.1).
 *   - No claim about voices, speech, conversations or transcripts appears anywhere, including
 *     marketing surfaces (2.3). This is a marketing surface.
 *   - No completion metric, no urgency, no streaks (7).
 *   - No claim of on-device or local-only processing (7). Method says the opposite, plainly.
 */

import { el } from './dom.js';

export interface TitleActions {
  onEnter(): void;
}

/**
 * The two figures, facing each other across the title.
 *
 * Decorative and hidden from assistive technology. They are `img` rather than CSS backgrounds so
 * they can be preloaded and given a real `srcset`.
 *
 * They hang off the pane rather than off the centred stack. An absolutely positioned child
 * resolves `inset` against its container's PADDING box, so nested any deeper they get clipped
 * along a rectangle set in from the viewport, and that clip cuts a visible straight edge across
 * both figures.
 *
 * They carry a real alpha channel, recovered from the sources rather than shipped with them: the
 * exports arrived with the editor's transparency grid burned into the pixels and no alpha at all.
 */
export function buildFigures(): HTMLElement {
  const wrap = el('div', { class: 'figures', 'aria-hidden': 'true' });
  for (const [side, file] of [['left', 'orimera1'], ['right', 'orimera2']] as const) {
    wrap.append(
      el('img', {
        class: `figure figure-${side}`,
        src: `/figures/${file}-1400.webp`,
        srcset: `/figures/${file}-900.webp 900w, /figures/${file}-1400.webp 1400w`,
        sizes: '31vw',
        alt: '',
        decoding: 'async',
      }),
    );
  }
  return wrap;
}

/**
 * THE NAME IS THE SMALL TEXT AND THE CATEGORY IS THE LARGE TEXT, which is the opposite of the
 * arrangement a title screen usually takes. A game can set its own name in the largest type on
 * the screen because whoever is reading already knows what the name means. Nobody arriving here
 * knows what Orimera is, so the large line is the sentence that tells them and the name sits
 * above it as the attribution.
 */
export function buildTitle(actions: TitleActions): HTMLElement {
  const root = el('section', { id: 'title', class: 'pane pane-title', tabindex: '-1' });

  const stack = el('div', { class: 'title' });
  stack.append(
    el('p', { class: 'brandline', text: 'Orimera' }),
    el('h1', { class: 'proposition', text: 'A Personal World Memory Model' }),
  );

  const start = el('button', { type: 'button', class: 'start', id: 'path-enter' }, [
    el('span', { class: 'start-word', text: 'Press' }),
    el('kbd', { class: 'key key-wide', text: 'Enter' }),
    el('span', { class: 'start-word', text: 'to start' }),
  ]);
  start.addEventListener('click', actions.onEnter);
  stack.append(start);

  root.append(stack);
  return root;
}

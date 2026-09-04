/** Exulanica's convictions, kept separate from the repository's changing implementation status. */

import { el } from './dom.js';

function para(...children: readonly (Node | string)[]): HTMLElement {
  return el('p', { class: 'prose' }, children);
}

function heading(text: string): HTMLElement {
  return el('h2', { class: 'prose-head', text });
}

/** The public account of what Exulanica believes a memory product owes its user. */
export function buildManifesto(): HTMLElement {
  const root = el('section', {
    id: 'manifesto',
    class: 'pane pane-method pane-manifesto',
    tabindex: '-1',
    'aria-labelledby': 'manifesto-title',
  });
  const inner = el('article', { class: 'prose-column' });

  inner.append(
    el('h1', { class: 'sr-only', id: 'manifesto-title', text: 'Manifesto' }),
    para(
      'A personal memory system should help you return to what happened without pretending it remembers more than the evidence does.',
    ),

    heading('Evidence comes before geometry'),
    para(
      'A reconstructed place can help you move through a memory. It cannot make a claim true. When Exulanica answers a question about your past, the answer must lead back to the photograph that supports it. The Atlas is a way to navigate the evidence, never a substitute for it.',
    ),

    heading('An inference is not a fact'),
    para(
      'The system may notice that two photographs seem connected. It may use that possibility to arrange a view or invite a decision. It may not turn the possibility into a statement about your life. Uncertain identity stays uncertain until you confirm it, and a person’s name comes from you or it does not exist.',
    ),

    heading('Every place should show what it earned'),
    para(
      'Sparse photographs do not become a complete room because the interface wants one. Exulanica should show the richest representation the source material can support, name its limits plainly, and leave unseen space unfilled. An honest source-first place is better than invented continuity.',
    ),

    heading('Uncertainty is allowed to remain'),
    para(
      'Not every connection has to be resolved. There is no score for tidying a life, no streak for reviewing it, and no pressure to finish. A memory is not a task.',
    ),

    heading('Operational limits belong in the product'),
    para(
      'Processing states should name the work actually happening and show only counts that are actually known. Storage, privacy, model, and reconstruction limits should be stated where they matter, in the same voice as the rest of the product. Careful language is part of the system, not a disclaimer added after it.',
    ),

    el('p', { class: 'prose prose-foot' }, [
      'The implementation inventory lives in ',
      el('button', {
        class: 'inline-link manifesto-capabilities-link',
        type: 'button',
        text: 'Capabilities',
      }),
      '. The full decisions and sources remain in the ',
      el('a', {
        class: 'inline-link',
        href: 'https://github.com/twinkling-reality/exulanica/tree/main/docs',
        rel: 'noreferrer',
        text: 'documentation',
      }),
      '.',
    ]),
  );

  root.append(inner);
  return root;
}

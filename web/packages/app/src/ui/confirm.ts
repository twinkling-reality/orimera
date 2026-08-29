/**
 * The confirmation surface. The only path from an intention to a write.
 *
 * interaction-model.md 5.1: "No free-text answer and no choice ever mutates the graph directly.
 * Every path, including a single click on 'Yes, the same person', produces an update proposal,
 * which is rendered, and only an explicit confirmation commits it."
 *
 * So this panel is not a nicety and it is not a dialog for dangerous things. It is the write
 * path. `commit` is reached from exactly one place in this package, here, and the proposal it
 * names must already have been staged and rendered.
 *
 * **Cancel restores instantly, because nothing was mutated** (5.3). There is no rollback here
 * for the same reason there is no spinner: discarding a proposal is forgetting a plan.
 *
 * **Reversibility is stated in words, and true.** The draft carries it; this renders it. A panel
 * that said "you can undo this" over an operation with no undo would be the one sentence in the
 * product it is least acceptable to get wrong.
 */

import type { ConfirmationSummary } from '@orimera/companion-runtime';
import { el, replace } from './dom.js';

export interface ConfirmHandlers {
  onConfirm(proposalId: string): void;
  onCancel(proposalId: string): void;
}

export interface ConfirmPanel {
  readonly root: HTMLElement;
  /** Render a staged proposal for reading. Shows the panel; writes nothing. */
  show(proposalId: string, summary: ConfirmationSummary, utterance: string): void;
  /** Report what happened to a commit, in the words the failure used. */
  reportFailure(reason: string): void;
  hide(): void;
}

export function buildConfirm(handlers: ConfirmHandlers): ConfirmPanel {
  const root = el('aside', { class: 'confirm', 'aria-label': 'Confirm', hidden: '' });

  return {
    root,
    show(proposalId, summary, utterance) {
      const confirm = el('button', { type: 'button', class: 'primary', text: 'Confirm' });
      const cancel = el('button', { type: 'button', class: 'ghost', text: 'Cancel' });
      confirm.addEventListener('click', () => handlers.onConfirm(proposalId));
      cancel.addEventListener('click', () => handlers.onCancel(proposalId));

      const children: (HTMLElement | string)[] = [
        el('h2', { text: 'Before anything is written' }),
        // The user's own words, verbatim. Not a summary of them.
        el('blockquote', { class: 'confirm-utterance', text: utterance }),
        el('p', { class: 'confirm-effect' }, [effectOf(summary)]),
        el('p', { class: 'confirm-reversible' }, [
          summary.reversible
            ? 'This can be undone, exactly, from the event it writes.'
            : 'This cannot be undone.',
        ]),
      ];

      if (summary.blastRadius !== null) {
        // Tier 2 and above must state what it touches before it touches it. Present exactly when
        // the tier requires it, which is a decision the policy table makes and this renders.
        children.push(
          el('p', { class: 'confirm-radius' }, [
            `This reaches ${summary.blastRadius.anchorCount} anchors across ` +
              `${summary.blastRadius.islandCount} regions.`,
          ]),
        );
      }
      if (!summary.permittedHere) {
        children.push(
          el('p', { class: 'confirm-refused' }, [
            'This operation is not offered from this surface.',
          ]),
        );
      }

      children.push(el('div', { class: 'confirm-actions' }, [confirm, cancel]));
      replace(root, children);
      root.hidden = false;
      confirm.focus();
    },
    reportFailure(reason) {
      root.hidden = false;
      replace(root, [
        el('h2', { text: 'Nothing was written' }),
        el('p', { class: 'confirm-refused', text: reason }),
        el('div', { class: 'confirm-actions' }, [
          (() => {
            const close = el('button', { type: 'button', class: 'ghost', text: 'Close' });
            close.addEventListener('click', () => {
              root.hidden = true;
            });
            return close;
          })(),
        ]),
      ]);
    },
    hide() {
      root.hidden = true;
      replace(root, []);
    },
  };
}

/**
 * What this proposal would do, from its bands rather than from a sentence somebody wrote.
 *
 * The pending rows ARE the change: `BandRow.pending` is what distinguishes a row that exists only
 * in this draft from one already in the graph. Deriving the sentence from them means the panel
 * cannot describe an effect the proposal does not have.
 */
function effectOf(summary: ConfirmationSummary): string {
  const pending = summary.bands.flatMap((band) => band.rows.filter((row) => row.pending));
  if (pending.length === 0) return 'This proposal changes nothing.';
  const written = pending
    .map((row) => row.verbatim ?? String(row.value ?? row.labelKey))
    .join(', ');
  return `This writes: ${written}. It becomes something you said, not something the system guessed.`;
}

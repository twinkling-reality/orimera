import type {
  CompanionSession,
  ConfirmationSummary,
  SelectionOutcome,
  Turn,
} from '@orimera/companion-runtime';
import type { EvidenceHandle, GraphSnapshot } from '@orimera/graph-client';
import type { CompanionPanel } from './ui/companion-panel.js';

/**
 * The turn loop. What turns the Companion's engine into a conversation.
 *
 * `companion-runtime` decides everything about a turn: which question, which options, what each
 * option would change, and what tier of consequence it carries. This file decides none of that. It
 * moves outcomes to surfaces, which is why it is short and why it should stay short: the model
 * writes words, the code writes consequences, and a controller that began choosing options would
 * be a third place where consequences are decided.
 *
 * **Every write still goes through the confirmation surface.** A selection returns
 * `awaiting_confirmation` carrying a proposal that is staged and not committed, and the only move
 * made here is handing it to the surface that renders it for reading. This file has no access to
 * commit and cannot acquire one: `Session` exposes stage and commit separately, and the gate never
 * leaves the composition root.
 */

export interface CompanionControllerOptions {
  readonly companion: CompanionSession;
  /** Render a staged proposal for reading. The only route from a turn to a write. */
  onAwaitingConfirmation(proposalId: string, summary: ConfirmationSummary, utterance: string): void;
}

export interface CompanionController {
  /** The panel is attached after construction, because it is built with handlers that call here. */
  attach(panel: CompanionPanel): void;
  current(): Turn | null;
  advance(nowMs: number): void;
  /** Call the Companion: generate a turn and open the panel onto it. */
  summon(nowMs: number): void;
  /** Send it away. The turn is kept, so summoning again resumes rather than re-asking. */
  dismiss(): void;
  /** Summon if away, dismiss if here. */
  toggle(nowMs: number): void;
  observeSnapshot(snapshot: GraphSnapshot): void;
  select(optionId: string): void;
  submit(optionIds: readonly string[]): void;
  say(text: string): void;
  /** The evidence behind a chip, for opening the photograph it came from. */
  evidenceAt(index: number): EvidenceHandle | null;
  /** Whether a turn is open. Drives the presence's attending behavior. */
  active(): boolean;
}

export function createCompanionController(
  options: CompanionControllerOptions,
): CompanionController {
  const { companion } = options;
  let turn: Turn | null = null;
  let panel: CompanionPanel | null = null;

  const render = (): void => panel?.render(turn);

  function handle(outcome: SelectionOutcome): void {
    switch (outcome.kind) {
      case 'advanced':
        turn = outcome.turn;
        render();
        return;
      case 'awaiting_confirmation':
        options.onAwaitingConfirmation(
          outcome.proposal.proposalId,
          outcome.confirmation,
          turn?.utterance ?? '',
        );
        return;
      case 'refused':
        // Reported in the words the refusal used. Rewording it into something friendlier here
        // would be inventing a reason, which is the one thing no surface may do.
        panel?.reportRefusal(outcome.reasonKey);
        return;
    }
  }

  return {
    attach(next) {
      panel = next;
      render();
    },
    current: () => turn,
    advance(nowMs) {
      turn = companion.advance(nowMs);
      render();
    },
    summon(nowMs) {
      // Resume rather than re-ask. Generating a fresh turn on every summon would consume a new
      // question each time the user glanced away, and the memory would fill with questions
      // nobody was ever shown.
      if (turn === null) turn = companion.advance(nowMs);
      panel?.setState('open');
      render();
    },
    dismiss() {
      panel?.setState('summon');
    },
    toggle(nowMs) {
      if (panel?.state() === 'open') this.dismiss();
      else this.summon(nowMs);
    },
    observeSnapshot(snapshot) {
      companion.observeSnapshot(snapshot);
    },
    select: (optionId) => handle(companion.select(optionId, Date.now())),
    submit: (optionIds) => handle(companion.submit(optionIds, Date.now())),
    say: (text) => handle(companion.say(text, Date.now())),
    evidenceAt: (index) => turn?.evidence[index] ?? null,
    active: () => panel?.state() === 'open',
  };
}

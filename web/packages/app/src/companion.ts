import {
  findOption,
  type CompanionSession,
  type ConfirmationSummary,
  type SelectionOutcome,
  type Turn,
} from '@orimera/companion-runtime';
import type { EvidenceHandle, GraphSnapshot } from '@orimera/graph-client';
import type { CompanionEncounter } from './ui/companion-encounter.js';
import { say } from './ui/copy.js';

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
  /** The encounter is attached after construction, because its handlers call back here. */
  attach(encounter: CompanionEncounter): void;
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
  let panel: CompanionEncounter | null = null;

  const render = (): void => panel?.render(turn);

  function handle(outcome: SelectionOutcome, answer: string): void {
    switch (outcome.kind) {
      case 'advanced':
        turn = outcome.turn;
        render();
        return;
      case 'awaiting_confirmation':
        options.onAwaitingConfirmation(
          outcome.proposal.proposalId,
          outcome.confirmation,
          answer,
        );
        return;
      case 'refused':
        // Reported in the words the refusal used. Rewording it into something friendlier here
        // would be inventing a reason, which is the one thing no surface may do.
        panel?.reportRefusal(outcome.reasonKey);
        return;
    }
  }

  const optionAnswer = (optionId: string): string => {
    if (turn === null) return '';
    const option = findOption(turn, optionId);
    return option === null ? '' : (option.phrasing ?? say(option.textKey));
  };

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
    select: (optionId) => handle(companion.select(optionId, Date.now()), optionAnswer(optionId)),
    submit: (optionIds) => handle(
      companion.submit(optionIds, Date.now()),
      optionIds.map(optionAnswer).filter(Boolean).join(', '),
    ),
    say: (text) => handle(companion.say(text, Date.now()), text),
    evidenceAt: (index) => turn?.evidence[index] ?? null,
    active: () => panel?.state() === 'open',
  };
}

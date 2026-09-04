import type {
  EntityIdRef,
  EntityRecord,
  EvidenceHandle,
  GraphSnapshot,
  UpdateProposal,
} from '@exulanica/graph-client';
import type { CommitResult, ProposalGate } from '@exulanica/graph-client/mutations';
import type { ConfirmationSummary } from './confirmation.js';
import { buildConfirmation } from './confirmation.js';
import type { DraftOperation, ProposalDraft } from './draft.js';
import { finalizeDraft, makeDraft } from './draft.js';
import { escapeDraft } from './escapes.js';
import type { IdFactory } from './ids.js';
import { sequentialIds } from './ids.js';
import type { CompanionMemory, TranscriptEntry } from './memory.js';
import { EMPTY_MEMORY, recordAsked, recordEscape, recordTranscript } from './memory.js';
import { generateTurn } from './generator.js';
import { subjectFootprint } from './pool.js';
import { draftFromParse, parseUtterance } from './parse.js';
import type { ConfirmationAcknowledgement, ConfirmationSurface } from './tiers.js';
import { assertMultiSelectable, unmetRequirements } from './tiers.js';
import type { Turn } from './turn.js';
import { findOption } from './turn.js';

/**
 * THE SESSION: turn -> selection -> draft -> staged proposal -> confirmation -> commit.
 *
 * The invariant this class exists to make unavoidable (interaction-model.md 5.1):
 *
 *   "NO FREE-TEXT ANSWER AND NO CHOICE EVER MUTATES THE GRAPH DIRECTLY. Every path, including a
 *   single click on 'Yes, the same person', produces an update proposal, which is rendered, and
 *   only an explicit confirmation commits it."
 *
 * There is therefore exactly one method on this class that can reach the graph (`commit`), it
 * takes a proposal id that must already be in the gate's pending set, and it refuses when the
 * tier's confirmation requirements are unmet. Behind it sits graph-client's `ProposalGate`,
 * which refuses again on its own terms. Two independent checks, because the guarantee is worth
 * more than the duplication.
 */

export type SelectionOutcome =
  /** The choice carried no consequence (tier 0). The conversation moved on. */
  | { readonly kind: 'advanced'; readonly turn: Turn }
  /** A proposal is staged and rendered. Nothing has been written. */
  | {
      readonly kind: 'awaiting_confirmation';
      readonly proposal: UpdateProposal;
      readonly confirmation: ConfirmationSummary;
    }
  /** The selection was not permitted. `reasonKey` is renderable. */
  | { readonly kind: 'refused'; readonly reasonKey: string };

export class ConfirmationRefusedError extends Error {
  constructor(
    message: string,
    readonly unmet: readonly string[],
  ) {
    super(message);
    this.name = 'ConfirmationRefusedError';
  }
}

interface PendingConfirmation {
  readonly proposal: UpdateProposal;
  readonly confirmation: ConfirmationSummary;
  readonly entity: EntityRecord | null;
}

export interface CompanionSessionOptions {
  readonly snapshot: GraphSnapshot;
  readonly gate: ProposalGate;
  readonly ids?: IdFactory;
  readonly memory?: CompanionMemory;
  /** Which mount point this session's confirmations render in. Tier 3 is refused in `dialogue`. */
  readonly surface?: ConfirmationSurface;
  readonly anchorForEvidence?: ReadonlyMap<EvidenceHandle, string>;
}

export class CompanionSession {
  #snapshot: GraphSnapshot;
  #memory: CompanionMemory;
  #turn: Turn | null = null;
  readonly #gate: ProposalGate;
  readonly #ids: IdFactory;
  readonly #surface: ConfirmationSurface;
  readonly #anchorForEvidence: ReadonlyMap<EvidenceHandle, string>;
  readonly #pending = new Map<string, PendingConfirmation>();

  constructor(options: CompanionSessionOptions) {
    this.#snapshot = options.snapshot;
    this.#gate = options.gate;
    this.#ids = options.ids ?? sequentialIds();
    this.#memory = options.memory ?? EMPTY_MEMORY;
    this.#surface = options.surface ?? 'dialogue';
    this.#anchorForEvidence = options.anchorForEvidence ?? new Map<EvidenceHandle, string>();
  }

  get snapshot(): GraphSnapshot {
    return this.#snapshot;
  }

  get memory(): CompanionMemory {
    return this.#memory;
  }

  get currentTurn(): Turn | null {
    return this.#turn;
  }

  /** Proposals staged and rendered but not committed. Cancelling one restores instantly. */
  get pendingProposalIds(): readonly string[] {
    return [...this.#pending.keys()];
  }

  /**
   * The graph moved underneath us.
   *
   * Not merged into `commit`, because the graph also moves for reasons this session did not
   * cause: another surface committed, a capture finished forming, a background job landed. Any
   * staged proposal computed against the old version is now describing a consequence that is no
   * longer the consequence, so it is dropped rather than silently re-aimed (5.1).
   */
  observeSnapshot(snapshot: GraphSnapshot): void {
    this.#snapshot = snapshot;
    for (const [id, pending] of [...this.#pending]) {
      if (pending.proposal.expiresAtStateVersion < snapshot.stateVersion) {
        this.#pending.delete(id);
        this.#gate.discard(id);
      }
    }
  }

  /** Generate and deliver the next turn. */
  advance(nowMs: number, focusEntityId?: EntityIdRef | null): Turn {
    const turn = generateTurn({
      snapshot: this.#snapshot,
      memory: this.#memory,
      nowMs,
      ids: this.#ids,
      ...(focusEntityId === undefined ? {} : { focusEntityId }),
    });
    // Recorded at DELIVERY, not at generation, so that re-rendering the same turn does not
    // consume the question and skip to the next one.
    this.#memory = recordAsked(this.#memory, turn.intent, turn.subjectEntityId);
    this.#turn = turn;
    return turn;
  }

  #entity(entityId: EntityIdRef | null): EntityRecord | null {
    if (entityId === null) return null;
    return this.#snapshot.entities.find((e) => e.entityId === entityId) ?? null;
  }

  #transcribe(entry: TranscriptEntry): void {
    this.#memory = recordTranscript(this.#memory, entry);
  }

  /** Stage a draft: build its proposal, render its confirmation, write nothing. */
  #stage(draft: ProposalDraft, turn: Turn): SelectionOutcome {
    const entity = this.#entity(draft.subjectEntityId);
    if (entity === null) {
      return { kind: 'refused', reasonKey: 'refused.subjectMissing' };
    }

    const proposal = finalizeDraft(
      draft,
      this.#ids('proposal'),
      turn.turnId,
      this.#snapshot.stateVersion,
    );
    const confirmation = buildConfirmation({
      draft,
      entity,
      surface: this.#surface,
      anchorForEvidence: this.#anchorForEvidence,
    });

    if (!confirmation.permittedHere) {
      return { kind: 'refused', reasonKey: 'refused.tierNotOfferableHere' };
    }

    this.#gate.stage(proposal);
    this.#pending.set(proposal.proposalId, { proposal, confirmation, entity });
    return { kind: 'awaiting_confirmation', proposal, confirmation };
  }

  /**
   * Select one option on the current turn.
   *
   * Escapes are handled here rather than in a separate method because 4.3 puts them in the same
   * option set as everything else, and a surface that had to route them differently would be one
   * refactor away from forgetting to offer them.
   */
  select(optionId: string, nowMs: number): SelectionOutcome {
    const turn = this.#turn;
    if (turn === null) return { kind: 'refused', reasonKey: 'refused.noTurn' };

    const option = findOption(turn, optionId);
    if (option === null) return { kind: 'refused', reasonKey: 'refused.unknownOption' };
    if (!option.available) {
      return { kind: 'refused', reasonKey: option.unavailableReasonKey ?? 'refused.unavailable' };
    }
    if (option.kind === 'multi_select') {
      // Multi mode has an explicit submit. Committing one checkbox on click would be exactly the
      // "renders a fixed form" failure the design is written against.
      return { kind: 'refused', reasonKey: 'refused.useSubmit' };
    }

    this.#transcribe({
      turnId: turn.turnId,
      intent: turn.intent,
      subjectEntityId: turn.subjectEntityId,
      optionId,
      escape: option.escape,
      rawUtterance: null,
      atMs: nowMs,
      stateVersion: this.#snapshot.stateVersion,
    });

    if (option.escape !== null) {
      this.#memory = recordEscape(this.#memory, {
        escape: option.escape,
        intent: turn.intent,
        entityId: turn.subjectEntityId,
        atMs: nowMs,
      });
      const draft = escapeDraft(
        option.escape,
        turn.intent,
        turn.subjectEntityId,
        '',
        this.#ids,
      );
      if (draft === null) return { kind: 'advanced', turn: this.advance(nowMs) };
      return this.#stage(draft, turn);
    }

    if (option.draft === null) {
      // Tier 0: "focus, emphasis, camera movement, opening the index. No proposal, no record."
      return { kind: 'advanced', turn: this.advance(nowMs) };
    }

    return this.#stage(option.draft, turn);
  }

  /**
   * Submit a multi-select set.
   *
   * The selected options are merged into ONE draft, so the user confirms one thing once. Every
   * option in the set is re-checked against `assertMultiSelectable`: the pool already refused to
   * build a tier 2 option into a multi set, and this is the second place that has to be true.
   */
  submit(optionIds: readonly string[], nowMs: number): SelectionOutcome {
    const turn = this.#turn;
    if (turn === null) return { kind: 'refused', reasonKey: 'refused.noTurn' };
    if (turn.choiceSet === null || turn.choiceSet.mode !== 'multi') {
      return { kind: 'refused', reasonKey: 'refused.notAMultiSet' };
    }
    if (optionIds.length === 0) return { kind: 'refused', reasonKey: 'refused.nothingSelected' };

    const operations: DraftOperation[] = [];
    for (const id of optionIds) {
      const option = findOption(turn, id);
      if (option === null) return { kind: 'refused', reasonKey: 'refused.unknownOption' };
      if (!option.available) {
        return { kind: 'refused', reasonKey: option.unavailableReasonKey ?? 'refused.unavailable' };
      }
      assertMultiSelectable(option.tier);
      if (option.draft !== null) operations.push(...option.draft.operations);
    }
    if (operations.length === 0) return { kind: 'advanced', turn: this.advance(nowMs) };

    this.#transcribe({
      turnId: turn.turnId,
      intent: turn.intent,
      subjectEntityId: turn.subjectEntityId,
      optionId: optionIds.join('+'),
      escape: null,
      rawUtterance: null,
      atMs: nowMs,
      stateVersion: this.#snapshot.stateVersion,
    });

    const draft = makeDraft({
      draftId: this.#ids('draft'),
      origin: 'user_choice',
      rawUtterance: '',
      subjectEntityId: turn.subjectEntityId,
      operations,
      provenanceSummaryKey: 'provenance.userSelectedAttributes',
    });
    return this.#stage(draft, turn);
  }

  /**
   * A free-text answer.
   *
   * 4.3: "It is parsed into the same update proposal draft that a choice would produce and goes
   * through the IDENTICAL confirmation flow." Identical means identical: the same `#stage`, the
   * same `buildConfirmation`, the same gate.
   */
  say(text: string, nowMs: number): SelectionOutcome {
    const turn = this.#turn;
    if (turn === null) return { kind: 'refused', reasonKey: 'refused.noTurn' };
    if (turn.subjectEntityId === null) {
      return { kind: 'refused', reasonKey: 'refused.noSubject' };
    }

    this.#transcribe({
      turnId: turn.turnId,
      intent: turn.intent,
      subjectEntityId: turn.subjectEntityId,
      optionId: null,
      escape: null,
      rawUtterance: text,
      atMs: nowMs,
      stateVersion: this.#snapshot.stateVersion,
    });

    const footprint = subjectFootprint(this.#snapshot, turn.subjectEntityId);
    const draft = draftFromParse(parseUtterance(text), {
      ids: this.#ids,
      subjectEntityId: turn.subjectEntityId,
      anchorIds: footprint.anchorIds,
      islandIds: footprint.islandIds,
      captureEvidence: footprint.evidence,
    });
    if (draft === null) return { kind: 'refused', reasonKey: 'refused.couldNotParse' };
    return this.#stage(draft, turn);
  }

  /** Cancel. Nothing was mutated, so there is nothing to roll back (5.3). */
  cancel(proposalId: string): void {
    this.#pending.delete(proposalId);
    this.#gate.discard(proposalId);
  }

  peekConfirmation(proposalId: string): ConfirmationSummary | null {
    return this.#pending.get(proposalId)?.confirmation ?? null;
  }

  /**
   * THE ONLY WRITE PATH.
   *
   * Refuses when the tier's requirements are unmet, listing every one of them, so a surface that
   * forgot the live preview learns which requirement it missed rather than that "commit failed".
   */
  async commit(proposalId: string, ack: ConfirmationAcknowledgement): Promise<CommitResult> {
    const pending = this.#pending.get(proposalId);
    if (pending === undefined) {
      throw new ConfirmationRefusedError(
        `proposal ${proposalId} is not staged in this session`,
        ['proposal.notStaged'],
      );
    }
    const unmet = unmetRequirements(
      pending.proposal.maxTier,
      ack,
      pending.entity?.displayName ?? null,
    );
    if (unmet.length > 0) {
      throw new ConfirmationRefusedError(
        `refusing to commit ${proposalId}: ${unmet.join(', ')}`,
        unmet,
      );
    }
    const result = await this.#gate.commit(proposalId);
    this.#pending.delete(proposalId);
    return result;
  }
}

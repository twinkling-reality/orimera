import type {
  EntityRecord,
  EvidenceHandle,
  GraphSnapshot,
  HistoryEvent,
  OccurrenceRecord,
  RelationView,
} from '@orimera/graph-client';
import { occurrencesOf } from '@orimera/graph-client';
import type { ProposalDraft, ProvenancePanel, ConfirmationSurface } from '@orimera/companion-runtime';
import { buildProvenancePanel } from '@orimera/companion-runtime';
import type { ActionOffer } from './actions.js';
import { availableActions } from './actions.js';
import type { IndexRow } from './rows.js';
import { toRow } from './rows.js';

/**
 * ENTITY DETAIL (interaction-model.md 6.1).
 *
 * "Entity detail has a FIXED SECTION ORDER: identity, the four-band provenance panel (THE SAME
 * COMPONENT AS 5.2), occurrences (a chronological evidence list, each opening the exact source
 * image: THIS LIST IS THE MECHANICAL ANSWER TO 'EVERY CLAIM RESOLVES TO A SOURCE'), relations,
 * and history."
 *
 * The order is exported as an array so a test can assert on it, because "fixed" is a claim that
 * has to survive somebody adding a section.
 */

export type DetailSection = 'identity' | 'provenance' | 'occurrences' | 'relations' | 'history';

export const DETAIL_SECTION_ORDER: readonly DetailSection[] = Object.freeze([
  'identity',
  'provenance',
  'occurrences',
  'relations',
  'history',
]);

/**
 * One occurrence, as a citation.
 *
 * Every field here exists to make a click land on the exact source: the evidence handles are
 * opaque and get resolved by graph-client, `capturedAtMs` is what the list sorts by, and
 * `anchorId` is what pulses in the Atlas at the same moment the image opens (5.2).
 *
 * People are citations, not reconstructions: a person occurrence renders as a time-anchored
 * presence marker that opens the original photograph, and this row is the non-spatial half of
 * that same promise.
 */
export interface OccurrenceCitation {
  readonly occurrenceId: string;
  readonly anchorId: string;
  readonly islandId: string;
  readonly capturedAtMs: number | null;
  readonly linkState: OccurrenceRecord['linkState'];
  readonly confidence: OccurrenceRecord['confidence'];
  readonly evidence: readonly EvidenceHandle[];
  /** True when the citation's own timestamp is unknown, which is a fact and not a blank. */
  readonly timeUnknown: boolean;
}

export interface EntityDetailView {
  readonly sections: readonly DetailSection[];
  readonly identity: IndexRow;
  readonly provenance: ProvenancePanel;
  /** Chronological. Unknown-time occurrences sort last and say so rather than pretending. */
  readonly occurrences: readonly OccurrenceCitation[];
  readonly relations: readonly RelationView[];
  readonly history: readonly HistoryEvent[];
  readonly actions: readonly ActionOffer[];
}

export interface EntityDetailInput {
  readonly snapshot: GraphSnapshot;
  readonly entity: EntityRecord;
  readonly surface?: ConfirmationSurface;
  /** A proposal under confirmation in this view, if any. The panel renders it as pending rows. */
  readonly pendingDraft?: ProposalDraft | null;
  readonly anchorForEvidence?: ReadonlyMap<EvidenceHandle, string>;
}

export function buildEntityDetail(input: EntityDetailInput): EntityDetailView {
  const occurrences = [...occurrencesOf(input.snapshot, input.entity.entityId)]
    .map((o) =>
      Object.freeze({
        occurrenceId: o.occurrenceId,
        anchorId: o.anchorId,
        islandId: o.islandId,
        capturedAtMs: o.capturedAtMs,
        linkState: o.linkState,
        confidence: o.confidence,
        evidence: o.evidence,
        timeUnknown: o.capturedAtMs === null,
      }),
    )
    .sort((a, b) => {
      if (a.capturedAtMs === null) return b.capturedAtMs === null ? 0 : 1;
      if (b.capturedAtMs === null) return -1;
      return a.capturedAtMs - b.capturedAtMs;
    });

  return Object.freeze({
    sections: DETAIL_SECTION_ORDER,
    identity: toRow(input.entity),
    // The same builder the dialogue panel calls. Not a similar one.
    provenance: buildProvenancePanel(
      input.entity,
      input.pendingDraft ?? null,
      input.anchorForEvidence,
    ),
    occurrences: Object.freeze(occurrences),
    relations: input.entity.relations,
    history: input.entity.history,
    actions: availableActions(input.entity, input.surface ?? 'world_index'),
  });
}

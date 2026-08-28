import type {
  AnchorIdRef,
  ConfidenceBand,
  ConsequenceTier,
  EntityRecord,
  EvidenceHandle,
  IslandIdRef,
} from '@orimera/graph-client';
import type { ProposalDraft } from './draft.js';
import { affectedAnchors, affectedIslands } from './draft.js';
import { PREDICATES } from './pool.js';
import type { ConfirmationSurface, TierPolicy } from './tiers.js';
import { tierPolicy } from './tiers.js';

/**
 * THE CONFIRMATION SURFACE (interaction-model.md 5.2).
 *
 * "Four bands in fixed order, top to bottom. THIS IS ONE COMPONENT WITH TWO MOUNT POINTS (the
 * dialogue panel and the World Index entity detail view), SO THE TWO CAN NEVER DIVERGE."
 *
 * It is one function here for exactly that reason. companion-runtime owns it because the
 * dialogue panel is the harder of the two mount points (it must render mid-conversation, against
 * a draft that has not been staged yet), and because world-index may import companion-runtime
 * while the reverse is forbidden. world-index calls this same function; there is no second
 * implementation to drift.
 *
 *   1. What you told me.          Warm accent. Quotes the user VERBATIM. Editable, removable.
 *   2. What the captures support. Neutral. Rows carry evidence chips.
 *   3. What I inferred.           Cool and dimmed. Method, confidence, explicit Reject.
 *   4. What I still do not know.  A plain list. NEVER OMITTED, EVEN WHEN SHORT.
 */

export type BandId = 'told' | 'captures' | 'inferred' | 'unknown';

/** Fixed order, top to bottom. The array is the spec. */
export const BAND_ORDER: readonly BandId[] = Object.freeze([
  'told',
  'captures',
  'inferred',
  'unknown',
]);

/**
 * An evidence chip. Carries the anchor as well as the handle because of what clicking it does:
 *
 * 5.2: "Clicking an evidence chip does not leave the Atlas. It opens the source image inline,
 * docked to the panel, AND SIMULTANEOUSLY THE CORRESPONDING ANCHOR IN THE WORLD PULSES. The
 * written claim and the spatial world point at the same evidence at the same time. That
 * simultaneity is the product's central promise made visible in one gesture."
 *
 * A chip that knew only the handle could do the first half and not the second.
 */
export interface EvidenceChip {
  readonly handle: EvidenceHandle;
  readonly anchorId: AnchorIdRef | null;
}

export interface BandRow {
  readonly rowKey: string;
  /** Verbatim user text for band 1; null elsewhere, where the row renders from `labelKey`. */
  readonly verbatim: string | null;
  readonly labelKey: string;
  readonly value: unknown;
  readonly evidence: readonly EvidenceChip[];
  /** Band 3 only: what produced it, and how sure it is. Qualitative, never a percentage. */
  readonly methodKey: string | null;
  readonly confidence: ConfidenceBand | null;
  readonly editable: boolean;
  readonly removable: boolean;
  /** Band 3 only: "Rows show method and confidence and carry an explicit Reject control." */
  readonly rejectable: boolean;
  /**
   * True for a row that exists only in an unconfirmed draft.
   *
   * This one flag is what lets the SAME component serve both mount points (5.2). In the dialogue
   * panel the pending rows are the thing being confirmed; in the World Index entity detail view
   * there are none and the panel is a record of what is already known. Without it the two mount
   * points would need two components, which is precisely what the document forbids.
   */
  readonly pending: boolean;
}

export interface ConfirmationBand {
  readonly band: BandId;
  /** Warm / neutral / cool-dimmed / plain. A tone key, not a colour: theming is not this layer. */
  readonly toneKey: 'warm' | 'neutral' | 'cool' | 'plain';
  readonly rows: readonly BandRow[];
  /** Band 4 is never omitted. Typed as the literal `false` so no surface can decide otherwise. */
  readonly omitted: false;
}

/** 5.3 tier 2: "A stated blast radius IN COUNTS: how many anchors, in which regions." */
export interface BlastRadius {
  readonly anchorCount: number;
  readonly islandCount: number;
  readonly islandIds: readonly IslandIdRef[];
  readonly anchorIds: readonly AnchorIdRef[];
}

/**
 * External-web knowledge, as a separate block rather than a fifth band.
 *
 * epi-2: `external` assertions "are STRUCTURALLY BARRED from supporting a historical clause ...
 * and they render in a visually distinct block labelled 'as of <date>'". 5.2's four bands do not
 * include external, and 6.1's row triad has three marks, yet external is one of four provenance
 * classes that must be visually distinguishable. It is therefore its own block, adjacent to the
 * bands, carrying the retrieval date the class is required to show.
 */
export interface ExternalBlock {
  readonly rows: readonly {
    readonly labelKey: string;
    readonly value: unknown;
    readonly url: string;
    readonly retrievedAtMs: number;
  }[];
  readonly asOfLabelKey: 'external.asOf';
  readonly barredFromHistoricalClaims: true;
}

export interface ConfirmationSummary {
  readonly draftId: string;
  readonly tier: ConsequenceTier;
  readonly policy: TierPolicy;
  /** Four bands, in fixed order, always. A tuple so the count cannot drift. */
  readonly bands: readonly [ConfirmationBand, ConfirmationBand, ConfirmationBand, ConfirmationBand];
  readonly external: ExternalBlock | null;
  /** Non-null exactly when the tier requires it. */
  readonly blastRadius: BlastRadius | null;
  /** 5.3: reversibility "stated in words, and TRUE". */
  readonly reversible: boolean;
  /** False when this surface may not offer this operation at all (tier 3 in the dialogue panel). */
  readonly permittedHere: boolean;
}

const OP_LABEL: Readonly<Record<string, string>> = Object.freeze({
  [PREDICATES.nameIs]: 'row.name',
  [PREDICATES.nameScopeIs]: 'row.nameScope',
  [PREDICATES.relationIs]: 'row.relation',
  [PREDICATES.sameEntityAs]: 'row.sameEntityAs',
  [PREDICATES.notThisClass]: 'row.notThisClass',
  [PREDICATES.uncertain]: 'row.uncertain',
  note: 'row.note',
});

function chips(
  handles: readonly EvidenceHandle[],
  anchorFor: ReadonlyMap<EvidenceHandle, AnchorIdRef>,
): readonly EvidenceChip[] {
  return handles.map((handle) =>
    Object.freeze({ handle, anchorId: anchorFor.get(handle) ?? null }),
  );
}

/**
 * Band 1: what you told me. Warm accent, verbatim, editable and removable.
 *
 * Rows come from the entity's own `user` assertions ALWAYS, and from the pending draft WHEN
 * THERE IS ONE. That is what makes this one component with two mount points rather than two
 * components that look alike: the dialogue panel sees the same history the index does, with the
 * thing under confirmation appended and flagged `pending`.
 */
function toldBand(entity: EntityRecord, draft: ProposalDraft | null): ConfirmationBand {
  const rows: BandRow[] = entity.assertions
    .filter((a) => a.status === 'active' && a.kind === 'user')
    .map((a) =>
      Object.freeze({
        rowKey: a.assertionId,
        verbatim: null,
        labelKey: OP_LABEL[a.predicateKey] ?? `row.${a.predicateKey}`,
        value: a.objectValue,
        evidence: Object.freeze([]),
        methodKey: null,
        confidence: null,
        editable: true,
        removable: true,
        rejectable: false,
        pending: false,
      }),
    );

  if (draft !== null) {
    draft.operations.forEach((op, i) => {
      const predicate =
        typeof op.payload['predicateKey'] === 'string'
          ? (op.payload['predicateKey'] as string)
          : op.op;
      rows.push(
        Object.freeze({
          rowKey: `${draft.draftId}:told:${i}`,
          // 5.1: the verbatim raw utterance, quoted, never paraphrased away.
          verbatim: draft.origin === 'user_utterance' ? draft.rawUtterance : null,
          labelKey: OP_LABEL[predicate] ?? `row.${op.op}`,
          value: op.payload,
          evidence: Object.freeze([]),
          methodKey: null,
          confidence: null,
          editable: true,
          removable: true,
          rejectable: false,
          pending: true,
        }),
      );
    });
  }

  return Object.freeze({ band: 'told', toneKey: 'warm', rows: Object.freeze(rows), omitted: false });
}

function captureBand(
  entity: EntityRecord,
  anchorFor: ReadonlyMap<EvidenceHandle, AnchorIdRef>,
): ConfirmationBand {
  const rows = entity.assertions
    .filter((a) => a.status === 'active' && a.kind === 'capture')
    .map((a) =>
      Object.freeze({
        rowKey: a.assertionId,
        verbatim: null,
        labelKey: `row.capture.${a.predicateKey}`,
        value: a.objectValue,
        evidence: chips(a.supportEvidence, anchorFor),
        methodKey: null,
        // A capture assertion has no confidence: it has support. epi-1 keeps these apart.
        confidence: null,
        editable: false,
        removable: false,
        rejectable: false,
        pending: false,
      }),
    );
  return Object.freeze({
    band: 'captures',
    toneKey: 'neutral',
    rows: Object.freeze(rows),
    omitted: false,
  });
}

function inferredBand(
  entity: EntityRecord,
  anchorFor: ReadonlyMap<EvidenceHandle, AnchorIdRef>,
): ConfirmationBand {
  const rows = entity.assertions
    .filter((a) => a.status === 'active' && a.kind === 'inference')
    .map((a) =>
      Object.freeze({
        rowKey: a.assertionId,
        verbatim: null,
        labelKey: `row.inferred.${a.predicateKey}`,
        value: a.objectValue,
        evidence: chips(a.supportEvidence, anchorFor),
        methodKey: a.producedBy.by === 'pipeline' ? `method.${a.producedBy.modelRef}` : 'method.unknown',
        confidence: a.confidence,
        editable: false,
        removable: false,
        // "carry an explicit Reject control."
        rejectable: true,
        pending: false,
      }),
    );
  return Object.freeze({
    band: 'inferred',
    toneKey: 'cool',
    rows: Object.freeze(rows),
    omitted: false,
  });
}

/**
 * Band 4: what is still open. NEVER OMITTED, EVEN WHEN SHORT.
 *
 * A fixed checklist rather than a computed absence, so that the band cannot quietly become empty
 * because a query returned nothing. If everything on the checklist is known, the band renders one
 * row saying so, and it still renders.
 */
function unknownBand(entity: EntityRecord, draft: ProposalDraft | null): ConfirmationBand {
  const drafted = new Set(
    (draft?.operations ?? []).map((o) =>
      typeof o.payload['predicateKey'] === 'string' ? (o.payload['predicateKey'] as string) : o.op,
    ),
  );
  const known = new Set(
    entity.assertions.filter((a) => a.status === 'active').map((a) => a.predicateKey),
  );
  const open = (predicate: string): boolean => !known.has(predicate) && !drafted.has(predicate);

  const rows: BandRow[] = [];
  const scope = draft?.draftId ?? entity.entityId;
  const push = (key: string): void => {
    rows.push(
      Object.freeze({
        rowKey: `${scope}:unknown:${key}`,
        verbatim: null,
        labelKey: key,
        value: null,
        evidence: Object.freeze([]),
        methodKey: null,
        confidence: null,
        editable: false,
        removable: false,
        rejectable: false,
        pending: false,
      }),
    );
  };

  if (entity.displayName === null && open(PREDICATES.nameIs)) push('unknown.name');
  if (entity.relations.length === 0 && open(PREDICATES.relationIs)) push('unknown.relation');
  if (entity.islandIds.length > 1 && open(PREDICATES.nameScopeIs)) push('unknown.nameScope');
  if (entity.firstSeenMs === null) push('unknown.whenFirstSeen');
  if (entity.contradictions.length > 0) push('unknown.contradiction');
  if (rows.length === 0) push('unknown.nothingOpen');

  return Object.freeze({ band: 'unknown', toneKey: 'plain', rows: Object.freeze(rows), omitted: false });
}

function externalBlock(entity: EntityRecord): ExternalBlock | null {
  const rows = entity.assertions
    .filter((a) => a.status === 'active' && a.kind === 'external')
    .flatMap((a) =>
      a.producedBy.by === 'external'
        ? [
            Object.freeze({
              labelKey: `row.external.${a.predicateKey}`,
              value: a.objectValue,
              url: a.producedBy.url,
              retrievedAtMs: a.producedBy.retrievedAtMs,
            }),
          ]
        : [],
    );
  if (rows.length === 0) return null;
  return Object.freeze({
    rows: Object.freeze(rows),
    asOfLabelKey: 'external.asOf',
    barredFromHistoricalClaims: true,
  });
}

/**
 * THE FOUR BANDS, with no tier and no proposal.
 *
 * This is the World Index entity detail mount point (6.1: "the four-band provenance panel, THE
 * SAME COMPONENT AS 5.2"). `buildConfirmation` is this function plus the tier obligations, so
 * the two surfaces cannot render different bands for the same entity: there is one band builder.
 */
export interface ProvenancePanel {
  readonly entityId: string;
  readonly bands: readonly [ConfirmationBand, ConfirmationBand, ConfirmationBand, ConfirmationBand];
  readonly external: ExternalBlock | null;
}

export function buildProvenancePanel(
  entity: EntityRecord,
  draft: ProposalDraft | null = null,
  anchorForEvidence: ReadonlyMap<EvidenceHandle, AnchorIdRef> = new Map(),
): ProvenancePanel {
  return Object.freeze({
    entityId: entity.entityId,
    bands: Object.freeze([
      toldBand(entity, draft),
      captureBand(entity, anchorForEvidence),
      inferredBand(entity, anchorForEvidence),
      unknownBand(entity, draft),
    ]) as ProvenancePanel['bands'],
    external: externalBlock(entity),
  });
}

export interface ConfirmationInput {
  readonly draft: ProposalDraft;
  readonly entity: EntityRecord;
  readonly surface: ConfirmationSurface;
  /** Evidence handle -> the anchor that pulses when its chip is clicked. */
  readonly anchorForEvidence?: ReadonlyMap<EvidenceHandle, AnchorIdRef>;
}

export function buildConfirmation(input: ConfirmationInput): ConfirmationSummary {
  const { draft, entity } = input;
  const policy = tierPolicy(draft.maxTier);
  const panel = buildProvenancePanel(entity, draft, input.anchorForEvidence);

  const anchorIds = affectedAnchors(draft);
  const islandIds = affectedIslands(draft);

  return Object.freeze({
    draftId: draft.draftId,
    tier: draft.maxTier,
    policy,
    bands: panel.bands,
    external: panel.external,
    blastRadius: policy.requiresBlastRadius
      ? Object.freeze({
          anchorCount: anchorIds.length,
          islandCount: islandIds.length,
          islandIds: Object.freeze([...islandIds]),
          anchorIds: Object.freeze([...anchorIds]),
        })
      : null,
    reversible: draft.reversible,
    permittedHere: policy.offerableFrom.includes(input.surface),
  });
}

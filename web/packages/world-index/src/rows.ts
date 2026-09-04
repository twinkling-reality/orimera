import type {
  AssertionKind,
  ConfidenceBand,
  EntityKind,
  EntityRecord,
  IndexStatus,
  IslandIdRef,
} from '@exulanica/graph-client';
import { knowledgeSources } from '@exulanica/graph-client';

/**
 * THE INDEX ROW (interaction-model.md 6.1).
 *
 * "A row shows a kind glyph, a display name OR AN HONEST PLACEHOLDER ('Unnamed person, 4
 * occurrences'), a three-mark provenance triad, an occurrence count, the regions present, and a
 * confidence bar ONLY FOR INFERRED ENTITIES."
 *
 * This is a view model, not markup. It carries message keys and booleans, and the binding turns
 * them into elements. That separation is what lets the same row render as a table row on desktop
 * and as a card in the mobile list without two implementations of the epistemic rules.
 */

/**
 * The three marks, plus external as a fourth and separate thing.
 *
 * The four provenance classes must be visually distinguishable wherever they appear, and 6.1
 * specifies a THREE-mark triad. Those are consistent only if external is not one of the marks:
 * epi-2 gives external its own rendering obligation ("a visually distinct block labelled 'as of
 * <date>'") precisely because it is not comparable to the other three. So the triad is
 * user / capture / inference, and external is a separate badge that carries its retrieval date.
 */
export interface ProvenanceTriad {
  readonly user: boolean;
  readonly capture: boolean;
  readonly inference: boolean;
}

export interface ExternalBadge {
  /** epi-2: external always renders "as of <date>". The date is not optional. */
  readonly latestRetrievedAtMs: number;
  readonly barredFromHistoricalClaims: true;
}

/**
 * An honest placeholder, as structured data rather than a pre-built sentence.
 *
 * "Unnamed person, 4 occurrences" is a name-shaped thing that is not a name, and it must never be
 * mistaken for one: id-1 says the occurrence is anonymous and only the entity holds a name, and
 * id-6 says names come solely from the account holder. A row that carried the placeholder in the
 * same `displayName` string field as a real name would erase that distinction in one assignment.
 */
export interface HonestPlaceholder {
  readonly key: 'placeholder.unnamed';
  readonly kind: EntityKind;
  readonly occurrenceCount: number;
}

export interface IndexRow {
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly glyphKey: string;
  /** Null exactly when nobody has named this. Never filled in with a guess. */
  readonly displayName: string | null;
  readonly placeholder: HonestPlaceholder | null;
  readonly status: IndexStatus;
  readonly triad: ProvenanceTriad;
  readonly external: ExternalBadge | null;
  readonly occurrenceCount: number;
  readonly islandIds: readonly IslandIdRef[];
  /** Non-null only for an inferred entity. See `showsConfidence`. */
  readonly confidence: ConfidenceBand | null;
  readonly openQuestionCount: number;
  readonly needsReview: boolean;
}

/**
 * Whether a confidence bar is shown.
 *
 * "a confidence bar ONLY FOR INFERRED ENTITIES." Read strictly: an entity the user has spoken
 * about is no longer one the system is guessing at, whatever the detector still thinks, and
 * showing a model's confidence next to the user's own statement invites the reading that the
 * system is grading them. So: inference-backed and not user-backed.
 */
export function showsConfidence(sources: readonly AssertionKind[]): boolean {
  return sources.includes('inference') && !sources.includes('user');
}

function externalBadge(entity: EntityRecord): ExternalBadge | null {
  let latest = 0;
  for (const a of entity.assertions) {
    if (a.status !== 'active' || a.kind !== 'external') continue;
    if (a.producedBy.by === 'external' && a.producedBy.retrievedAtMs > latest) {
      latest = a.producedBy.retrievedAtMs;
    }
  }
  return latest === 0
    ? null
    : Object.freeze({ latestRetrievedAtMs: latest, barredFromHistoricalClaims: true });
}

export function toRow(entity: EntityRecord): IndexRow {
  const sources = knowledgeSources(entity);
  return Object.freeze({
    entityId: entity.entityId,
    kind: entity.kind,
    glyphKey: `glyph.${entity.kind}`,
    displayName: entity.displayName,
    placeholder:
      entity.displayName === null
        ? Object.freeze({
            key: 'placeholder.unnamed' as const,
            kind: entity.kind,
            occurrenceCount: entity.occurrenceCount,
          })
        : null,
    status: entity.status,
    triad: Object.freeze({
      user: sources.includes('user'),
      capture: sources.includes('capture'),
      inference: sources.includes('inference'),
    }),
    external: externalBadge(entity),
    occurrenceCount: entity.occurrenceCount,
    islandIds: entity.islandIds,
    confidence: showsConfidence(sources) ? entity.confidence : null,
    openQuestionCount: entity.openQuestionCount,
    needsReview: entity.status === 'needs_review',
  });
}

import type { LocalVec3 } from './coords.js';
import type { AnchorId, EntityId, EvidenceRef, IslandId, OccurrenceId } from './ids.js';
import type { ConfidenceBand, LinkState, ProvenanceClass } from './provenance.js';

/** What kind of thing an anchor stands for. Mirrors `occurrence_class` minus the deferred kinds. */
export type AnchorKind = 'person' | 'place' | 'object' | 'event';

/**
 * An anchor is a detection made addressable in space. It is scene-local and it NEVER carries a
 * name (domain-and-evidence-model.md id-1: the occurrence is anonymous, the entity holds the
 * name). `displayName` is deliberately absent from this type. The renderer asks graph-client for
 * the entity's name at label time, which is what keeps a detector from writing one.
 */
export interface Anchor {
  readonly anchorId: AnchorId;
  readonly islandId: IslandId;
  readonly occurrenceId: OccurrenceId;
  readonly kind: AnchorKind;

  /**
   * Position in the island's OWN frame. Not an atlas position. Converting requires the island's
   * placement, which is exactly the friction the frame separation is for.
   */
  readonly local: LocalVec3;

  /**
   * Radius of the focus volume, in local units. The focus solver widens its aim cone by the
   * angle this subtends, which is what makes a small nearby object selectable without
   * pixel-precise aim (interaction-model.md 3.3).
   */
  readonly focusRadiusLocal: number;

  /** Null while the occurrence is not linked to any entity. */
  readonly entityId: EntityId | null;
  readonly linkState: LinkState;
  readonly provenance: ProvenanceClass;
  readonly confidence: ConfidenceBand;

  /** How many occurrences the linked entity has across the whole workspace. Drives importance. */
  readonly occurrenceCount: number;

  /**
   * True when there is nothing left to ask about this anchor. Drives the ambient initiative
   * channel (interaction-model.md 5.5): unresolved anchors swap breathing for a slower cooler
   * pulse and take a dashed ground ring. No text.
   */
  readonly resolved: boolean;

  /**
   * Opaque handles, never parsed here (interaction-model.md 3.4).
   *
   * People are not baked into geometry: a person anchor renders as a time-anchored presence
   * marker, a sprite cropped from the source at the estimated position, which opens the original
   * photograph when clicked. These refs are what it opens.
   */
  readonly evidence: readonly EvidenceRef[];
}

/**
 * People are citations, not reconstructions.
 *
 * The renderer binding uses this to decide between a presence marker and world geometry. It is a
 * predicate rather than a flag on the anchor so that it cannot be set to false by mistake for a
 * person, which would bake a person into the scene.
 */
export function rendersAsPresenceMarker(anchor: Anchor): boolean {
  return anchor.kind === 'person';
}

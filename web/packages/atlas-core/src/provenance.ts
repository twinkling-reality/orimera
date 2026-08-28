/**
 * The epistemic vocabulary, carried in the scene graph because it drives what things LOOK like.
 *
 * domain-and-evidence-model.md 2.1 defines four provenance classes and they are four different
 * things, not four shades of the same thing. interaction-model.md 6.1 requires the same
 * trichotomy in the World Index facet and in the confirmation panel: one vocabulary everywhere.
 */

export type ProvenanceClass =
  /** A deterministic property of the recording: bytes, dimensions, EXIF. */
  | 'capture'
  /** ANY model output, however confident. epi-1: a detection is an inference. */
  | 'inference'
  /** Stated by the human. The only class permitted to write a name. */
  | 'user'
  /** Live-web lookup about a PUBLIC entity. epi-2: structurally barred from historical clauses. */
  | 'external';

/**
 * Link state between an occurrence and an entity (domain-and-evidence-model.md 4.3).
 *
 * id-2 is the line the whole product turns on: `auto_provisional` may drive Atlas layout,
 * filtering and highlighting; it may never support a historical factual clause.
 */
export type LinkState = 'proposed' | 'auto_provisional' | 'confirmed' | 'rejected' | 'revoked';

/**
 * Qualitative confidence only.
 *
 * domain-and-evidence-model.md 2.3: `raw_score` is never rendered and `calibrated_p` is NULL
 * until a calibration bin has enough observed decisions. Until then the UI shows low/medium/high
 * and the copy says "the system thinks". A percentage implies a frequency guarantee that cannot
 * be made, so this type deliberately cannot hold one.
 */
export type ConfidenceBand = 'low' | 'medium' | 'high';

/** Whether a link is settled enough to move the world. */
export function isConfirmed(state: LinkState): boolean {
  return state === 'confirmed';
}

/**
 * Whether a link may influence LAYOUT.
 *
 * interaction-model.md 1.4: "Target separation is derived from a semantic similarity score
 * dominated by shared confirmed or high-confidence entities. Speculative links must never move
 * the world; otherwise the layout twitches every time the pipeline guesses."
 *
 * So `auto_provisional` counts only at high confidence, and `proposed` never counts.
 */
export function contributesToLayout(state: LinkState, confidence: ConfidenceBand): boolean {
  if (state === 'confirmed') return true;
  if (state === 'auto_provisional') return confidence === 'high';
  return false;
}

/**
 * Whether an anchor should read as UNCONFIRMED.
 *
 * The renderer turns this into per-point dissolve. The point of routing it through here is that
 * the dissolve is driven by real semantic state and not by a shader that was told to look
 * mysterious.
 */
export function readsAsUnconfirmed(state: LinkState, provenance: ProvenanceClass): boolean {
  if (provenance === 'user') return false;
  return state !== 'confirmed';
}

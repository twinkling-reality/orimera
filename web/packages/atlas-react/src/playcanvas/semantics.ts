import type { ConfidenceBand, LinkState, ProvenanceClass } from '@orimera/atlas-core';
import { readsAsUnconfirmed } from '@orimera/atlas-core';
import type { OpmHeader } from './opm.js';

/**
 * Per-point semantic state, and how it reaches the shader.
 *
 * The rule this file exists to satisfy: "an unconfirmed candidate must LOOK unconfirmed. Per-point
 * dissolve driven by real semantic state, not a shader told to look mysterious"
 * (interaction-model.md, product framing). So the dissolve amount is computed from
 * `readsAsUnconfirmed`, which lives in atlas-core, and never from a magic number in a shader.
 *
 * Two further rules land here rather than in the renderer:
 *
 *   - Capture-supported, model-inferred, user-provided and external-web are FOUR DIFFERENT THINGS
 *     and must be visually distinguishable wherever they appear. They get four palette slots, and
 *     the slot index is what the shader reads. Which colour a slot is remains a theme decision.
 *   - People are NOT baked into geometry. A segment whose class is `person` is excluded from the
 *     point cloud entirely and rendered as a time-anchored presence marker by the overlay. That is
 *     enforced here, at the point where segment classes are read, so a renderer cannot forget.
 *
 * The table is small (one entry per segment, twelve in the shipped fixture) and is uploaded as one
 * uniform array. Nothing is per-point on the CPU.
 */

export const MAX_SEGMENTS = 16;

/** Palette slots, not colours. Four classes, four slots, and they never collapse to three. */
export const PROVENANCE_SLOT: Readonly<Record<ProvenanceClass, number>> = Object.freeze({
  capture: 0,
  inference: 1,
  user: 2,
  external: 3,
});

const CONFIDENCE_FLOOR: Readonly<Record<ConfidenceBand, number>> = Object.freeze({
  low: 0.25,
  medium: 0.6,
  high: 1,
});

export interface SegmentSemantics {
  readonly id: number;
  readonly name: string;
  readonly cls: string;
  readonly provenance: ProvenanceClass;
  readonly linkState: LinkState;
  readonly confidence: ConfidenceBand;
}

/**
 * The default epistemic reading of a monocular point map.
 *
 * Every point in a rung 3 reconstruction is a model output, so the provenance is `inference` for
 * every class, including structure and ground. `ProvenanceClass` defines `capture` as "a
 * deterministic property of the recording: bytes, dimensions, EXIF" and `inference` as "ANY model
 * output, however confident" (epi-1), and a depth network's opinion about where a wall is fails
 * the first definition and meets the second. Structure once read as `capture` here, which was a
 * fixture convenience: the synthetic generator's structure IS exact, and calling real
 * reconstruction the same thing told the interface a photograph had measured a wall it had only
 * been used to guess at.
 *
 * The LINK STATE is a separate question and stays `confirmed` for surfaces. `LinkState` is
 * defined between an occurrence and an entity, and an unsegmented shell asserts no identity at
 * all: it says "there is surface here", not "that is the glasshouse". There is nothing to be
 * unconfirmed about, so the per-point dissolve that `readsAsUnconfirmed` drives stays off, and
 * how well sampled a point is travels in the alpha channel instead. Water and vegetation keep
 * their proposals, because the generator degrades those in blotches and that IS a claim.
 *
 * This mapping is a DEFAULT for the bake-off fixture, not a claim about a real capture. Real
 * per-segment epistemics come from graph-client; the shape of what the shader consumes is the
 * same either way, which is the part the bake-off is testing.
 */
export function defaultSemanticsFor(header: OpmHeader): SegmentSemantics[] {
  return header.segments.map((s) => {
    switch (s.cls) {
      case 'structure':
      case 'ground':
        return {
          ...s,
          provenance: 'inference' as const,
          linkState: 'confirmed' as const,
          confidence: 'high' as const,
        };
      case 'person':
        // Never geometry. See `isPresenceMarkerOnly`.
        return {
          ...s,
          provenance: 'inference' as const,
          linkState: 'auto_provisional' as const,
          confidence: 'high' as const,
        };
      case 'water':
        return {
          ...s,
          provenance: 'inference' as const,
          linkState: 'proposed' as const,
          confidence: 'low' as const,
        };
      case 'vegetation':
        return {
          ...s,
          provenance: 'inference' as const,
          linkState: 'proposed' as const,
          confidence: 'medium' as const,
        };
      default:
        return {
          ...s,
          provenance: 'inference' as const,
          linkState: 'auto_provisional' as const,
          confidence: 'medium' as const,
        };
    }
  });
}

/**
 * People render as time-anchored presence markers, never as points in the shell.
 *
 * A predicate over the segment class rather than a flag, for the same reason atlas-core makes
 * `rendersAsPresenceMarker` a predicate over the anchor kind: a flag can be set wrong and bake a
 * person into the world.
 */
export function isPresenceMarkerOnly(segment: SegmentSemantics): boolean {
  return segment.cls === 'person';
}

/**
 * Pack the table into the vec4 array the shader indexes by segment id.
 *
 *   x  unconfirmed          0 or 1. Drives per-point stochastic dissolve.
 *   y  provenance slot      0..3. Four classes, four visually distinct treatments.
 *   z  presence-marker-only 0 or 1. 1 means DISCARD: not geometry.
 *   w  confidence floor     0..1. Multiplies the per-point confidence from the colour alpha.
 */
export function packSemantics(segments: readonly SegmentSemantics[]): Float32Array {
  const out = new Float32Array(MAX_SEGMENTS * 4);
  for (const s of segments) {
    if (s.id < 0 || s.id >= MAX_SEGMENTS) continue;
    const o = s.id * 4;
    out[o] = readsAsUnconfirmed(s.linkState, s.provenance) ? 1 : 0;
    out[o + 1] = PROVENANCE_SLOT[s.provenance];
    out[o + 2] = isPresenceMarkerOnly(s) ? 1 : 0;
    out[o + 3] = CONFIDENCE_FLOOR[s.confidence];
  }
  return out;
}

/** How many points the shader will discard as presence-marker-only, for honest reporting. */
export function presenceMarkerSegmentIds(segments: readonly SegmentSemantics[]): number[] {
  return segments.filter(isPresenceMarkerOnly).map((s) => s.id);
}

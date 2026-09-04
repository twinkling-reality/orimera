import type { Anchor, AnchorId, EmphasisBuffers } from '@exulanica/atlas-core';
import { readsAsUnconfirmed } from '@exulanica/atlas-core';
import type { OpmHeader } from './opm.js';

/**
 * Per-point semantic state, and the indirection that makes it cheap.
 *
 * Requirement: an unconfirmed candidate must GENUINELY dissolve, driven by real semantic state
 * rather than by a shader told to look mysterious. The state that decides it lives in the entity
 * graph (`linkState`, `provenance`, `confidence`) and in the applied view manifest (emphasis).
 * Both change at interaction rate. Points do not.
 *
 * So the state is NOT a per-point attribute. Each point already carries a `segment` id, and a
 * segment is what a detection covers, so the shader reads
 *
 *     segment id -> 256x1 RGBA8 state texture -> appearance
 *
 * and a merge, a confirmation or a recomposition writes 1 KB and flags one texture. That is
 * interaction-model.md 7.5's performance contract ("a manifest change writes one typed array and
 * flags it") applied to a point cloud rather than to instanced anchors. Rebuilding a 4M-point
 * attribute buffer per hover would be four orders of magnitude more work for the same picture.
 *
 * SPEC GAP, reported rather than papered over. `atlas-core`'s `Anchor` has no field naming the
 * region of the capture a detection covers, so nothing in the scene graph can say "this anchor
 * owns segment 8". The caller therefore supplies an explicit binding table. In a real pipeline
 * that id comes from the segmentation the detector already ran; the shape it should take is an
 * open question for atlas-core, not a decision this binding should make silently.
 */

/** Provenance code, quantised into a byte so the shader can branch on four distinct classes. */
export const PROVENANCE_CODE = Object.freeze({
  capture: 0,
  inference: 85,
  user: 170,
  external: 255,
});

export const SEGMENT_FLAG = Object.freeze({
  /** People are NOT baked into geometry. A person segment is dropped from the cloud entirely. */
  person: 1,
  focused: 2,
  /** The segment is covered by an anchor at all. Unbound segments are plain capture surface. */
  bound: 4,
  /** Unresolved: the ambient initiative channel (interaction-model.md 5.5). Cool slow pulse. */
  unresolved: 8,
});

export const SEGMENT_TABLE_WIDTH = 256;

/** How unconfirmed something reads, 0..1. Only ever derived; never authored on an anchor. */
export function unconfirmedWeight(anchor: Anchor): number {
  if (!readsAsUnconfirmed(anchor.linkState, anchor.provenance)) return 0;
  const byConfidence = anchor.confidence === 'high' ? 0.35 : anchor.confidence === 'medium' ? 0.65 : 1;
  // `proposed` is a guess the system has not even provisionally acted on; `auto_provisional` may
  // drive layout and highlighting but never a factual clause (domain model id-2). The gap
  // between them is the thing the user must be able to see, so it is the dominant term.
  const byState = anchor.linkState === 'proposed' ? 1 : anchor.linkState === 'auto_provisional' ? 0.6 : 0.8;
  return Math.min(1, byConfidence * byState);
}

export interface SegmentBinding {
  /** Segment id in the `.opm`, 0..255. */
  readonly segment: number;
  readonly anchorId: AnchorId;
}

export interface SegmentStateOptions {
  /** Anchor lookup by id, in anchor-table index order, for reading the emphasis buffers. */
  readonly indexOf: ReadonlyMap<AnchorId, number>;
  readonly anchors: readonly Anchor[];
}

/**
 * The 256x1 RGBA8 state table for one island.
 *
 * Owns its own `Uint8Array`; `update` writes into it in place and returns whether anything
 * changed, so the caller can skip the texture upload on a frame where nothing moved.
 */
export class SegmentStateTable {
  readonly data = new Uint8Array(SEGMENT_TABLE_WIDTH * 4);
  private readonly bySegment = new Map<number, { anchor: Anchor; index: number }>();
  private readonly personSegments = new Set<number>();
  private readonly present = new Set<number>();

  constructor(header: OpmHeader, bindings: readonly SegmentBinding[], options: SegmentStateOptions) {
    for (const s of header.segments) {
      this.present.add(s.id);
      if (s.cls === 'person') this.personSegments.add(s.id);
    }
    for (const b of bindings) {
      if (!this.present.has(b.segment)) {
        throw new Error(`segment binding names segment ${b.segment}, which is not in the .opm`);
      }
      const index = options.indexOf.get(b.anchorId);
      if (index === undefined) continue; // Anchor is not in this scene. Ignored, not fatal.
      const anchor = options.anchors[index];
      if (anchor === undefined) continue;
      this.bySegment.set(b.segment, { anchor, index });
    }
  }

  /** Segment ids whose class is `person`. The point material discards them. */
  get personSegmentIds(): ReadonlySet<number> {
    return this.personSegments;
  }

  /**
   * Recompute the table from the current emphasis frame.
   *
   * @param islandEmphasis the island's own emphasis scalar, which unbound capture surface takes.
   * @param focusedAnchorIndex the single focused anchor, or null. Attention is single-valued.
   * @returns true when a byte changed, so the caller uploads; false to skip the upload.
   */
  update(
    emphasis: EmphasisBuffers,
    islandEmphasis: number,
    focusedAnchorIndex: number | null,
  ): boolean {
    let changed = false;
    const write = (id: number, r: number, g: number, b: number, a: number): void => {
      const o = id * 4;
      if (this.data[o] !== r || this.data[o + 1] !== g || this.data[o + 2] !== b || this.data[o + 3] !== a) {
        this.data[o] = r;
        this.data[o + 1] = g;
        this.data[o + 2] = b;
        this.data[o + 3] = a;
        changed = true;
      }
    };

    const islandByte = Math.round(Math.min(1, Math.max(0, islandEmphasis)) * 255);

    for (const id of this.present) {
      const bound = this.bySegment.get(id);
      let flags = this.personSegments.has(id) ? SEGMENT_FLAG.person : 0;

      if (bound === undefined) {
        // Unbound capture surface. Capture-supported, never a candidate, follows the island.
        write(id, islandByte, 0, PROVENANCE_CODE.capture, flags);
        continue;
      }

      flags |= SEGMENT_FLAG.bound;
      if (!bound.anchor.resolved) flags |= SEGMENT_FLAG.unresolved;
      if (focusedAnchorIndex !== null && focusedAnchorIndex === bound.index) {
        flags |= SEGMENT_FLAG.focused;
      }

      const e = emphasis.anchorEmphasis[bound.index] ?? 0;
      write(
        id,
        Math.round(Math.min(1, Math.max(0, e)) * 255),
        Math.round(unconfirmedWeight(bound.anchor) * 255),
        PROVENANCE_CODE[bound.anchor.provenance],
        flags,
      );
    }

    return changed;
  }
}

/**
 * Bind `.opm` segments to anchors by segment NAME, with an alias map for the cases where the
 * detector's label and the anchor's key differ.
 *
 * Kept as data rather than as a heuristic on the anchor id, because a substring match between a
 * detection label and an anchor id is exactly the kind of quiet coupling that produces a wrong
 * dissolve on a scene nobody re-checked.
 */
export function bindSegmentsByName(
  header: OpmHeader,
  anchors: readonly Anchor[],
  aliases: Readonly<Record<string, string>> = {},
): SegmentBinding[] {
  const anchorByKey = new Map<string, Anchor>();
  for (const a of anchors) {
    const slash = a.anchorId.lastIndexOf('/');
    anchorByKey.set(slash < 0 ? a.anchorId : a.anchorId.slice(slash + 1), a);
  }
  const out: SegmentBinding[] = [];
  for (const s of header.segments) {
    const key = aliases[s.name] ?? s.name;
    const anchor = anchorByKey.get(key);
    if (anchor !== undefined) out.push({ segment: s.id, anchorId: anchor.anchorId });
  }
  return out;
}

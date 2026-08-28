import * as pc from 'playcanvas';
import type { AnchorTable, EmphasisBuffers } from '@orimera/atlas-core';
import {
  MAX_CAPTIONS,
  MAX_EDGE_CHEVRONS,
  MAX_FOCUS_LABELS,
  levelAt,
  rendersAsPresenceMarker,
} from '@orimera/atlas-core';

/**
 * Screen-space anchors, projected manually from world positions into PRE-ALLOCATED DOM nodes.
 *
 * Three rules from the interaction model are structural here rather than aspirational:
 *
 *   1. HARD CAPS. One focus label, six pinned callouts, four edge chevrons. The nodes are
 *      allocated once at construction to exactly those counts and are then only ever shown,
 *      hidden and transformed. Nothing in `update` can create a node, so the overlay cannot grow
 *      into an inventory screen no matter what the scene contains.
 *   2. NO PER-FRAME REACT. This module owns raw DOM and writes `transform` and `opacity` inside
 *      the render loop. React would re-render only when the SET of overlay elements changes,
 *      which is a transition event, not a frame event. There is no React import in this file and
 *      there must not be one.
 *   3. AT MOST ONE LABEL. Attention is single-valued, so the focus label is a single node driven
 *      by the single winner the focus solver returns.
 *
 * And one product rule that lands here and nowhere else: PEOPLE ARE NOT BAKED INTO GEOMETRY. A
 * person anchor is drawn as a time-anchored presence marker carrying a timestamp, visibly a
 * citation rather than a reconstruction, and the point cloud has already discarded the person
 * points (see `semantics.ts`). The marker is the only place a person appears in the Atlas.
 *
 * The overlay is also the accessibility surface, because canvas content is invisible to screen
 * readers. Nodes carry real roles and text.
 */

export interface OverlayCounts {
  readonly focusLabels: number;
  readonly callouts: number;
  readonly chevrons: number;
  readonly presenceMarkers: number;
}

interface Node {
  readonly root: HTMLDivElement;
  visible: boolean;
}

function makeNode(className: string, parent: HTMLElement): Node {
  const root = document.createElement('div');
  root.className = className;
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  root.style.willChange = 'transform';
  root.style.display = 'none';
  root.style.pointerEvents = 'none';
  parent.appendChild(root);
  return { root, visible: false };
}

function show(node: Node, x: number, y: number, opacity: number): void {
  if (!node.visible) {
    node.root.style.display = '';
    node.visible = true;
  }
  node.root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  node.root.style.opacity = opacity.toFixed(3);
}

function hide(node: Node): void {
  if (node.visible) {
    node.root.style.display = 'none';
    node.visible = false;
  }
}

export interface OverlayFrame {
  readonly table: AnchorTable;
  readonly emphasis: EmphasisBuffers;
  readonly camera: pc.CameraComponent;
  readonly focusedIndex: number | null;
  readonly widthCss: number;
  readonly heightCss: number;
  /** Epoch milliseconds for the anchor whose presence marker is being stamped. */
  readonly capturedAt: number;
}

export class AnchorOverlay {
  readonly root: HTMLDivElement;
  private readonly focusLabel: Node;
  private readonly callouts: Node[];
  private readonly chevrons: Node[];
  private readonly markers: Node[];

  private readonly vp = new pc.Mat4();
  private readonly p = new pc.Vec4();

  private lastCounts: OverlayCounts = {
    focusLabels: 0,
    callouts: 0,
    chevrons: 0,
    presenceMarkers: 0,
  };

  /**
   * @param markerBudget how many presence markers may exist. Not one of the three documented
   * caps, because a presence marker is world content rather than a callout, but it is still a
   * fixed pool: the overlay never allocates during a frame.
   */
  constructor(parent: HTMLElement, markerBudget = 12) {
    this.root = document.createElement('div');
    this.root.className = 'orimera-overlay';
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Atlas anchors');
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.root.style.pointerEvents = 'none';
    parent.appendChild(this.root);

    this.focusLabel = makeNode('ov-focus', this.root);
    this.callouts = Array.from({ length: MAX_CAPTIONS }, () => makeNode('ov-callout', this.root));
    this.chevrons = Array.from({ length: MAX_EDGE_CHEVRONS }, () =>
      makeNode('ov-chevron', this.root),
    );
    this.markers = Array.from({ length: markerBudget }, () => makeNode('ov-marker', this.root));

    if (MAX_FOCUS_LABELS !== 1) {
      throw new Error('the overlay is built around exactly one focus label');
    }
  }

  get counts(): OverlayCounts {
    return this.lastCounts;
  }

  /**
   * Project one atlas position. Returns null when the point is behind the camera.
   *
   * Done by hand rather than through a helper that mounts a DOM element per instance: the common
   * React-three helper allocates a wrapper element per anchor and documents blurriness in its
   * transform mode, which is correct for one or two elements and wrong for hundreds.
   */
  private project(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
  ): { sx: number; sy: number; depth: number } | null {
    this.p.set(x, y, z, 1);
    this.vp.transformVec4(this.p, this.p);
    if (this.p.w <= 1e-6) return null;
    const inv = 1 / this.p.w;
    return {
      sx: (this.p.x * inv * 0.5 + 0.5) * w,
      sy: (1 - (this.p.y * inv * 0.5 + 0.5)) * h,
      depth: this.p.w,
    };
  }

  update(frame: OverlayFrame): void {
    const { table, emphasis, camera, widthCss: w, heightCss: h } = frame;
    this.vp.mul2(camera.projectionMatrix, camera.viewMatrix);

    let calloutUsed = 0;
    let chevronUsed = 0;
    let markerUsed = 0;
    let focusUsed = 0;

    // Candidates in table order, which is deterministic across both bindings, so the two
    // renderers put the same anchors in the same six slots.
    for (let i = 0; i < table.count; i += 1) {
      if (emphasis.anchorLabelable[i] === 0) continue;

      const anchor = table.anchors[i]!;
      const px = table.atlasPositions[i * 3]!;
      const py = table.atlasPositions[i * 3 + 1]!;
      const pz = table.atlasPositions[i * 3 + 2]!;
      const projected = this.project(px, py, pz, w, h);
      const scalar = emphasis.anchorEmphasis[i]!;

      if (projected === null) continue;
      const onScreen =
        projected.sx >= 0 && projected.sx <= w && projected.sy >= 0 && projected.sy <= h;

      if (i === frame.focusedIndex && focusUsed < MAX_FOCUS_LABELS && onScreen) {
        // Offset to the lower right so the label never occludes the reticle at screen centre.
        this.focusLabel.root.textContent = this.focusText(table, i, frame.capturedAt);
        show(this.focusLabel, projected.sx + 18, projected.sy + 14, 1);
        focusUsed += 1;
        continue;
      }

      if (rendersAsPresenceMarker(anchor) && onScreen && markerUsed < this.markers.length) {
        const node = this.markers[markerUsed]!;
        node.root.textContent = new Date(frame.capturedAt).toISOString().slice(0, 10);
        node.root.dataset['linkState'] = anchor.linkState;
        node.root.dataset['provenance'] = anchor.provenance;
        show(node, projected.sx - 14, projected.sy - 34, Math.max(0.35, scalar));
        markerUsed += 1;
        continue;
      }

      if (!onScreen) {
        if (chevronUsed < MAX_EDGE_CHEVRONS) {
          // Clamp to an inset rounded rect and rotate toward the true direction.
          const inset = 28;
          const cx = w / 2;
          const cy = h / 2;
          const dx = projected.sx - cx;
          const dy = projected.sy - cy;
          const scale = Math.min(
            (w / 2 - inset) / Math.max(Math.abs(dx), 1e-3),
            (h / 2 - inset) / Math.max(Math.abs(dy), 1e-3),
          );
          const node = this.chevrons[chevronUsed]!;
          node.root.style.setProperty('--angle', `${Math.atan2(dy, dx).toFixed(3)}rad`);
          show(node, cx + dx * scale, cy + dy * scale, 0.75);
          chevronUsed += 1;
        }
        continue;
      }

      if (calloutUsed < MAX_CAPTIONS) {
        const node = this.callouts[calloutUsed]!;
        node.root.textContent = `${anchor.kind} · ${levelAt(emphasis, i)}`;
        node.root.dataset['provenance'] = anchor.provenance;
        // Fixed-increment collision push, down and to the right, per the overlay rules. The
        // leader line back to the true point is a CSS pseudo-element on the node.
        show(node, projected.sx + 10 + calloutUsed * 4, projected.sy + calloutUsed * 22, scalar);
        calloutUsed += 1;
      }
    }

    if (focusUsed === 0) hide(this.focusLabel);
    for (let i = calloutUsed; i < this.callouts.length; i += 1) hide(this.callouts[i]!);
    for (let i = chevronUsed; i < this.chevrons.length; i += 1) hide(this.chevrons[i]!);
    for (let i = markerUsed; i < this.markers.length; i += 1) hide(this.markers[i]!);

    this.lastCounts = {
      focusLabels: focusUsed,
      callouts: calloutUsed,
      chevrons: chevronUsed,
      presenceMarkers: markerUsed,
    };
  }

  /**
   * Three lines at most: an honest placeholder rather than a name, a provenance and confidence
   * chip, and the verb hint. This binding has no graph-client, so the name is deliberately absent
   * rather than invented; an anchor never carries a display name in the first place.
   */
  private focusText(table: AnchorTable, index: number, capturedAt: number): string {
    const a = table.anchors[index]!;
    const name =
      a.entityId === null
        ? `Unnamed ${a.kind}, ${a.occurrenceCount} occurrences`
        : `${a.kind} · ${a.occurrenceCount} occurrences`;
    const stamp = new Date(capturedAt).toISOString().slice(0, 10);
    return `${name}\n${a.provenance} · ${a.confidence} · ${a.linkState}\n${stamp} · Interact [E]`;
  }

  destroy(): void {
    this.root.remove();
  }
}

import { Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type {
  Anchor,
  AnchorTable,
  EmphasisBuffers,
  EntityId,
  FocusCandidate,
} from '@exulanica/atlas-core';
import {
  MAX_CAPTIONS,
  MAX_EDGE_CHEVRONS,
  levelAt,
  readsAsUnconfirmed,
} from '@exulanica/atlas-core';

/**
 * Screen-space anchors: 3D world positions projected by hand into pre-allocated DOM nodes.
 *
 * interaction-model.md 3.4 fixes the mechanism and the caps, and both are load-bearing:
 *
 *   - "Anchors are projected manually each frame from world space into normalized device
 *     coordinates and written as direct transform updates into pre-allocated DOM nodes inside
 *     the render loop. No React re-render per frame."
 *   - "DECISION: do not mount a per-anchor DOM helper component." drei's `<Html>` mounts a real
 *     DOM element with a wrapper per instance and documents blurriness in transform mode. That
 *     is correct for one or two elements and wrong for hundreds of anchors.
 *     https://drei.docs.pmnd.rs/misc/html  (VERIFIED)
 *   - Hard caps: 1 focus label, 6 pinned callouts, 4 edge chevrons. Nothing else exists.
 *
 * Every node this class will ever use is created in the constructor. Per frame it writes
 * `style.transform` and toggles one class; it never creates, removes or reparents a node, and it
 * never reads layout back, so the whole overlay is one style-recalculation and no reflow.
 *
 * NAMES DO NOT COME FROM HERE. An `Anchor` never carries a display name: the occurrence is
 * anonymous and the entity holds the name, which is what keeps a detector from writing one. The
 * caller injects a resolver, so the binding depends on no graph transport and stays testable
 * with a stub.
 */

export interface ResolvedName {
  /** The entity's display name, or null when nothing has named it yet. */
  readonly name: string | null;
  /** What to show instead. "Unnamed person, 4 occurrences" is the documented shape. */
  readonly placeholder: string;
}

export type NameResolver = (entityId: EntityId | null, anchor: Anchor) => ResolvedName;

export interface OverlayFrameInput {
  readonly table: AnchorTable;
  readonly emphasis: EmphasisBuffers;
  readonly camera: PerspectiveCamera;
  readonly width: number;
  readonly height: number;
  readonly focused: FocusCandidate | null;
  /** Ordered anchor indices the active view manifest wants called out. Sliced to the caps. */
  readonly pinned: readonly number[];
  /** Suppresses the focus label in `converse`, where the reticle is dimmed and targeting is off. */
  readonly mode: 'traverse' | 'converse';
}

const CALLOUT_HEIGHT = 30;
const CALLOUT_MIN_GAP = 6;
const EDGE_INSET = 44;

interface CalloutNode {
  readonly root: HTMLDivElement;
  readonly text: HTMLSpanElement;
  readonly chip: HTMLSpanElement;
  lastText: string;
  lastChip: string;
}

function provenanceChip(anchor: Anchor): { label: string; cls: string } {
  // Four provenance classes are four different things, not four shades of one thing, and they
  // must be visually distinguishable wherever they appear (domain-and-evidence-model.md 2.1).
  // Confidence is a band, never a percentage: a percentage implies a frequency guarantee that
  // cannot be made until a calibration bin has enough observed decisions.
  switch (anchor.provenance) {
    case 'user':
      return { label: 'you told me', cls: 'prov-user' };
    case 'capture':
      return { label: 'in the photograph', cls: 'prov-capture' };
    case 'external':
      return { label: 'from the web', cls: 'prov-external' };
    default:
      return {
        label: `the system thinks (${anchor.confidence})`,
        cls: readsAsUnconfirmed(anchor.linkState, anchor.provenance)
          ? 'prov-inference unconfirmed'
          : 'prov-inference',
      };
  }
}

export class AnchorOverlay {
  readonly root: HTMLDivElement;

  private readonly focusLabel: HTMLDivElement;
  private readonly focusName: HTMLSpanElement;
  private readonly focusChip: HTMLSpanElement;
  private readonly focusVerb: HTMLSpanElement;
  private readonly callouts: CalloutNode[] = [];
  private readonly chevrons: HTMLDivElement[] = [];
  private readonly leaders: SVGLineElement[] = [];
  private readonly overflow: HTMLDivElement;
  private readonly svg: SVGSVGElement;

  private readonly view = new Matrix4();
  private readonly tmp = new Vector3();
  private lastFocusText = '';

  constructor(
    container: HTMLElement,
    private readonly resolveName: NameResolver,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'atlas-overlay';

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'atlas-leaders');
    this.root.appendChild(this.svg);

    this.focusLabel = document.createElement('div');
    this.focusLabel.className = 'atlas-focus-label';
    this.focusName = document.createElement('span');
    this.focusName.className = 'name';
    this.focusChip = document.createElement('span');
    this.focusChip.className = 'chip';
    this.focusVerb = document.createElement('span');
    this.focusVerb.className = 'verb';
    this.focusVerb.textContent = 'Space to interact';
    this.focusLabel.append(this.focusName, this.focusChip, this.focusVerb);
    this.root.appendChild(this.focusLabel);

    for (let i = 0; i < MAX_CAPTIONS; i += 1) {
      const node = document.createElement('div');
      node.className = 'atlas-callout';
      const text = document.createElement('span');
      text.className = 'name';
      const chip = document.createElement('span');
      chip.className = 'chip';
      node.append(text, chip);
      this.root.appendChild(node);
      this.callouts.push({ root: node, text, chip, lastText: '', lastChip: '' });

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'leader');
      this.svg.appendChild(line);
      this.leaders.push(line);
    }

    for (let i = 0; i < MAX_EDGE_CHEVRONS; i += 1) {
      const node = document.createElement('div');
      node.className = 'atlas-chevron';
      node.textContent = '▲';
      this.root.appendChild(node);
      this.chevrons.push(node);
    }

    this.overflow = document.createElement('div');
    this.overflow.className = 'atlas-overflow';
    this.root.appendChild(this.overflow);

    container.appendChild(this.root);
  }

  /**
   * One frame. Returns how many anchors were considered, for the harness's honesty column: an
   * overlay that silently drew nothing would otherwise look like a fast renderer.
   */
  update(input: OverlayFrameInput): { drawn: number; chevrons: number; overflow: number } {
    const { camera, width, height, table, emphasis } = input;
    this.svg.setAttribute('width', String(width));
    this.svg.setAttribute('height', String(height));
    this.view.copy(camera.matrixWorldInverse);

    // ---- the single focus label -------------------------------------------------------------
    // "At most one label exists at any time. That single constraint is the whole answer to how
    // we avoid covering the world in glowing labels."
    if (input.focused !== null && input.mode === 'traverse') {
      const i = input.focused.index;
      const anchor = table.anchors[i]!;
      const p = this.project(table, i, camera, width, height);
      if (p !== null) {
        const resolved = this.resolveName(anchor.entityId, anchor);
        const label = resolved.name ?? resolved.placeholder;
        const chip = provenanceChip(anchor);
        if (label !== this.lastFocusText) {
          this.focusName.textContent = label;
          this.focusChip.textContent = chip.label;
          this.focusChip.className = `chip ${chip.cls}`;
          this.lastFocusText = label;
        }
        // Offset to the lower right so it never occludes the centre (3.2 stage 2).
        this.focusLabel.style.transform = `translate3d(${p.x + 26}px, ${p.y + 18}px, 0)`;
        this.focusLabel.classList.add('visible');
      } else {
        this.focusLabel.classList.remove('visible');
      }
    } else {
      this.focusLabel.classList.remove('visible');
      this.lastFocusText = '';
    }

    // ---- pinned callouts, capped at six, with a screen-space collision pass -----------------
    let drawn = 0;
    let lastBottom = -Infinity;
    const offscreen: number[] = [];

    for (let slot = 0; slot < this.callouts.length; slot += 1) {
      const node = this.callouts[slot]!;
      const line = this.leaders[slot]!;
      const index = input.pinned[slot];
      if (index === undefined || levelAt(emphasis, index) === 'hidden') {
        node.root.classList.remove('visible');
        line.setAttribute('stroke-opacity', '0');
        continue;
      }
      const p = this.project(table, index, camera, width, height);
      if (p === null) {
        node.root.classList.remove('visible');
        line.setAttribute('stroke-opacity', '0');
        offscreen.push(index);
        continue;
      }

      const anchor = table.anchors[index]!;
      const resolved = this.resolveName(anchor.entityId, anchor);
      const label = resolved.name ?? resolved.placeholder;
      if (label !== node.lastText) {
        node.text.textContent = label;
        node.lastText = label;
      }
      const chip = provenanceChip(anchor);
      if (chip.label !== node.lastChip) {
        node.chip.textContent = chip.label;
        node.chip.className = `chip ${chip.cls}`;
        node.lastChip = chip.label;
      }

      // "a screen-space collision pass that pushes overlapping labels down and right in fixed
      // increments with a leader line back to the true projected point". Fixed increments, and
      // the pass never measures the DOM: a `getBoundingClientRect` here would force a layout
      // inside the render loop, which is the exact cost this design exists to avoid.
      let ly = p.y;
      let lx = p.x + 18;
      if (ly < lastBottom + CALLOUT_MIN_GAP) {
        ly = lastBottom + CALLOUT_MIN_GAP;
        lx += 22;
      }
      lastBottom = ly + CALLOUT_HEIGHT;

      node.root.style.transform = `translate3d(${lx}px, ${ly}px, 0)`;
      node.root.classList.add('visible');
      node.root.style.opacity = String(0.35 + 0.65 * (emphasis.anchorEmphasis[index] ?? 1));

      if (Math.abs(ly - p.y) > 2 || Math.abs(lx - p.x) > 24) {
        line.setAttribute('x1', String(p.x));
        line.setAttribute('y1', String(p.y));
        line.setAttribute('x2', String(lx));
        line.setAttribute('y2', String(ly + CALLOUT_HEIGHT / 2));
        line.setAttribute('stroke-opacity', '0.42');
      } else {
        line.setAttribute('stroke-opacity', '0');
      }
      drawn += 1;
    }

    // ---- edge chevrons, capped at four ------------------------------------------------------
    let chevrons = 0;
    for (let slot = 0; slot < this.chevrons.length; slot += 1) {
      const node = this.chevrons[slot]!;
      const index = offscreen[slot] ?? input.pinned[this.callouts.length + slot];
      if (index === undefined) {
        node.classList.remove('visible');
        continue;
      }
      const dir = this.directionOnScreen(table, index, camera, width, height);
      if (dir === null) {
        node.classList.remove('visible');
        continue;
      }
      node.style.transform =
        `translate3d(${dir.x}px, ${dir.y}px, 0) rotate(${dir.angleDeg}deg)`;
      node.classList.add('visible');
      chevrons += 1;
    }

    const overflowCount = Math.max(0, input.pinned.length - this.callouts.length);
    if (overflowCount > 0) {
      const text = `+${overflowCount} more, open World Index`;
      if (this.overflow.textContent !== text) this.overflow.textContent = text;
      this.overflow.classList.add('visible');
    } else {
      this.overflow.classList.remove('visible');
    }

    return { drawn, chevrons, overflow: overflowCount };
  }

  /** NDC projection with an explicit behind-camera gate. Allocates nothing. */
  private project(
    table: AnchorTable,
    index: number,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ): { x: number; y: number } | null {
    this.tmp.set(
      table.atlasPositions[index * 3]!,
      table.atlasPositions[index * 3 + 1]!,
      table.atlasPositions[index * 3 + 2]!,
    );
    this.tmp.applyMatrix4(this.view);
    // `Vector3.applyMatrix4` performs the perspective divide, and w flips sign behind the
    // camera, so a point behind the viewer would otherwise project to a plausible-looking
    // mirrored position. Gate first, project second.
    if (this.tmp.z > -camera.near) return null;
    this.tmp.applyMatrix4(camera.projectionMatrix);
    if (this.tmp.x < -1.2 || this.tmp.x > 1.2 || this.tmp.y < -1.2 || this.tmp.y > 1.2) {
      return null;
    }
    return {
      x: (this.tmp.x * 0.5 + 0.5) * width,
      y: (-this.tmp.y * 0.5 + 0.5) * height,
    };
  }

  /** Clamp an off-screen anchor to an inset rect, rotated toward its true direction. */
  private directionOnScreen(
    table: AnchorTable,
    index: number,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ): { x: number; y: number; angleDeg: number } | null {
    this.tmp.set(
      table.atlasPositions[index * 3]!,
      table.atlasPositions[index * 3 + 1]!,
      table.atlasPositions[index * 3 + 2]!,
    );
    this.tmp.applyMatrix4(this.view);
    const behind = this.tmp.z > -camera.near;
    this.tmp.applyMatrix4(camera.projectionMatrix);
    let nx = this.tmp.x;
    let ny = this.tmp.y;
    if (behind) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(nx, ny);
    if (!behind && len < 1) return null;
    if (len === 0) return null;
    const cx = width / 2;
    const cy = height / 2;
    const halfW = cx - EDGE_INSET;
    const halfH = cy - EDGE_INSET;
    const scale = Math.min(halfW / Math.abs(nx / len), halfH / Math.abs(ny / len));
    const x = cx + (nx / len) * scale;
    const y = cy - (ny / len) * scale;
    const angleDeg = (Math.atan2(-ny, nx) * 180) / Math.PI + 90;
    return { x, y, angleDeg };
  }

  dispose(): void {
    this.root.remove();
  }
}

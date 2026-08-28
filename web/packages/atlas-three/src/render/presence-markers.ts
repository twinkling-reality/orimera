import {
  CanvasTexture,
  Group,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
} from 'three';
import type { Anchor, AnchorTable, EmphasisBuffers } from '@orimera/atlas-core';
import { rendersAsPresenceMarker } from '@orimera/atlas-core';

/**
 * People are citations, not reconstructions.
 *
 * A person anchor renders as a TIME-ANCHORED PRESENCE MARKER: a sprite cropped from the source
 * at the estimated position, stamped with a timestamp, which opens the original photograph when
 * clicked. Visibly a citation, not a reconstruction. The point material drops every point whose
 * segment class is `person`, so this is the only place a person appears in the world at all, and
 * the two halves of that rule are deliberately in different files: someone who disables the
 * marker gets no person rather than a silently reconstructed one.
 *
 * `rendersAsPresenceMarker` is a predicate in atlas-core rather than a flag on the anchor,
 * precisely so it cannot be set false for a person by mistake. This class asks it and never
 * second-guesses the answer.
 *
 * The card is drawn to look like an ARTEFACT and not like a body: a hard rectangular frame, a
 * caption bar, a timestamp, and a visible crop boundary. Nothing about it is soft-edged, because
 * the soft-edged particulate treatment in this binding means "reconstructed surface" and a
 * person is not one.
 */

const CARD_W = 256;
const CARD_H = 320;

export interface PresenceMarkerContent {
  /** What to write on the card. Never a name the system inferred; the caller decides. */
  readonly caption: string;
  /** The stamped time. Rendered verbatim; this class does not format or guess a timezone. */
  readonly timestamp: string;
  /** Optional real crop from the source photograph. Absent until the evidence resolver returns. */
  readonly crop?: HTMLImageElement | HTMLCanvasElement | ImageBitmap;
}

export type PresenceContentResolver = (anchor: Anchor) => PresenceMarkerContent;

function drawCard(content: PresenceMarkerContent, unconfirmed: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CARD_W;
  c.height = CARD_H;
  const g = c.getContext('2d')!;

  g.fillStyle = 'rgba(12,14,19,0.86)';
  g.fillRect(0, 0, CARD_W, CARD_H);

  const inset = 10;
  const imgH = CARD_H - 74;
  if (content.crop !== undefined) {
    g.drawImage(content.crop, inset, inset, CARD_W - inset * 2, imgH - inset);
  } else {
    // No crop yet. An empty frame with a stated reason, never a placeholder silhouette: a
    // silhouette is a picture of a person the system does not have.
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(inset, inset, CARD_W - inset * 2, imgH - inset);
    g.fillStyle = 'rgba(210,220,235,0.55)';
    g.font = '15px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('source crop', CARD_W / 2, imgH / 2 - 6);
    g.fillText('not loaded', CARD_W / 2, imgH / 2 + 14);
  }

  g.strokeStyle = unconfirmed ? 'rgba(140,190,255,0.75)' : 'rgba(235,240,250,0.85)';
  g.lineWidth = 2;
  if (unconfirmed) g.setLineDash([7, 5]);
  g.strokeRect(inset, inset, CARD_W - inset * 2, imgH - inset);
  g.setLineDash([]);

  g.fillStyle = 'rgba(235,240,250,0.95)';
  g.font = '600 17px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText(content.caption, inset + 2, imgH + 22);

  g.fillStyle = 'rgba(170,185,205,0.8)';
  g.font = '13px ui-monospace, SFMono-Regular, monospace';
  g.fillText(content.timestamp, inset + 2, imgH + 44);

  g.fillStyle = 'rgba(140,190,255,0.9)';
  g.font = '12px ui-sans-serif, system-ui, sans-serif';
  g.fillText('opens the photograph', inset + 2, imgH + 64);

  return c;
}

export class PresenceMarkers {
  readonly group = new Group();
  /** Anchor table index for each sprite, so a reticle hit maps back without a raycast. */
  readonly indices: number[] = [];
  private readonly sprites: Sprite[] = [];
  private readonly worldHeight: number;

  constructor(table: AnchorTable, resolve: PresenceContentResolver, worldHeight = 1.9) {
    this.worldHeight = worldHeight;
    this.group.name = 'presence-markers';
    for (let i = 0; i < table.count; i += 1) {
      const anchor = table.anchors[i]!;
      if (!rendersAsPresenceMarker(anchor)) continue;

      const unconfirmed = anchor.linkState !== 'confirmed';
      const texture = new CanvasTexture(drawCard(resolve(anchor), unconfirmed));
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.generateMipmaps = false;

      const sprite = new Sprite(
        new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
      );
      sprite.scale.set((worldHeight * CARD_W) / CARD_H, worldHeight, 1);
      sprite.position.set(
        table.atlasPositions[i * 3]!,
        table.atlasPositions[i * 3 + 1]!,
        table.atlasPositions[i * 3 + 2]!,
      );
      sprite.name = anchor.anchorId;
      // Render after the opaque point cloud. The cloud writes depth, so a marker behind a wall
      // is correctly occluded, which matters: a citation floating through a building would be a
      // claim about where the person was that the reconstruction cannot support.
      sprite.renderOrder = 10;
      this.group.add(sprite);
      this.sprites.push(sprite);
      this.indices.push(i);
    }
  }

  /** Emphasis follows the manifest like everything else. Muted, never hidden by a query. */
  update(emphasis: EmphasisBuffers, focusedIndex: number | null): void {
    for (let s = 0; s < this.sprites.length; s += 1) {
      const i = this.indices[s]!;
      const sprite = this.sprites[s]!;
      const e = emphasis.anchorEmphasis[i] ?? 1;
      sprite.visible = e > 0.002;
      const material = sprite.material as SpriteMaterial;
      material.opacity = 0.35 + 0.65 * e;
      const boost = focusedIndex === i ? 1.08 : 1;
      const h = this.worldHeight * boost;
      sprite.scale.set((h * CARD_W) / CARD_H, h, 1);
    }
  }

  dispose(): void {
    for (const sprite of this.sprites) {
      const material = sprite.material as SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.group.clear();
  }
}

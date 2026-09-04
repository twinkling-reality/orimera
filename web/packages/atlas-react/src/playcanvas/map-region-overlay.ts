import * as pc from 'playcanvas';
import type { AtlasScene, IslandId } from '@exulanica/atlas-core';

interface RegionNode {
  readonly islandId: IslandId;
  readonly position: pc.Vec3;
  readonly button: HTMLButtonElement;
}

/**
 * The Map's interaction layer. Region sigils are preallocated once, then projected from the same
 * persisted transforms the world renders. No parallel screen-space layout can drift from Atlas.
 */
export class MapRegionOverlay {
  readonly root: HTMLDivElement;
  private readonly regions: readonly RegionNode[];
  private readonly vp = new pc.Mat4();
  private readonly p = new pc.Vec4();
  private active = false;

  onSelect: ((islandId: IslandId) => void) | null = null;

  constructor(
    parent: HTMLElement,
    scene: AtlasScene,
    labels: ReadonlyMap<IslandId, string | undefined> = new Map(),
  ) {
    this.root = document.createElement('div');
    this.root.className = 'map-regions';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Atlas Map regions');
    this.root.hidden = true;
    parent.appendChild(this.root);

    this.regions = Object.freeze(
      [...scene.islands]
        .sort(
          (a, b) =>
            a.creationOrdinal - b.creationOrdinal ||
            (a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0),
        )
        .map((island, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'map-region-target';
          const label = labels.get(island.islandId) ?? `Region ${String(index + 1).padStart(2, '0')}`;
          button.textContent = label;
          button.setAttribute('aria-label', `Travel to ${label}`);
          button.addEventListener('click', () => this.onSelect?.(island.islandId));
          this.root.appendChild(button);
          return Object.freeze({
            islandId: island.islandId,
            position: new pc.Vec3(
              island.placement.position.x,
              island.placement.position.y + 0.18,
              island.placement.position.z,
            ),
            button,
          });
        }),
    );
  }

  setActive(active: boolean): void {
    this.active = active;
    this.root.hidden = !active;
  }

  update(
    camera: pc.CameraComponent,
    widthCss: number,
    heightCss: number,
    renderOrigin: readonly [number, number, number] = [0, 0, 0],
  ): void {
    if (!this.active) return;
    this.vp.mul2(camera.projectionMatrix, camera.viewMatrix);
    for (const region of this.regions) {
      this.p.set(
        region.position.x - renderOrigin[0],
        region.position.y - renderOrigin[1],
        region.position.z - renderOrigin[2],
        1,
      );
      this.vp.transformVec4(this.p, this.p);
      if (this.p.w <= 1e-6) {
        region.button.hidden = true;
        continue;
      }
      const inverseW = 1 / this.p.w;
      const x = (this.p.x * inverseW * 0.5 + 0.5) * widthCss;
      const y = (1 - (this.p.y * inverseW * 0.5 + 0.5)) * heightCss;
      const onScreen = x >= 0 && x <= widthCss && y >= 0 && y <= heightCss;
      region.button.hidden = !onScreen;
      if (onScreen) {
        region.button.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
    }
  }

  destroy(): void {
    this.root.remove();
  }
}

import {
  BufferAttribute,
  BufferGeometry,
  Points,
  Sphere,
  Vector3,
} from 'three';
import type { Anchor, AnchorId, EmphasisBuffers, Island } from '@orimera/atlas-core';
import type { OccupancyGrid } from '../containment.js';
import { buildOccupancyGrid } from '../containment.js';
import type { PointMapData } from '../opm.js';
import type { SegmentBinding } from '../semantic-state.js';
import { SegmentStateTable } from '../semantic-state.js';
import type { PointAppearanceSettings, PointFrameUniforms } from './point-material.js';
import { PointMaterial } from './point-material.js';

/**
 * One island, drawn once, in the shared canvas.
 *
 * There is exactly one scene graph for the whole session (interaction-model.md 1.1), so an
 * `IslandView` is created when an island's point map arrives and is never torn down and rebuilt
 * for a view change. Everything a query or a tier change does is a uniform write or a 1 KB
 * texture upload; nothing here reallocates a buffer.
 *
 * The island's presentation transform is applied as the object's own matrix rather than by
 * transforming points on the CPU. That keeps `localToAtlas` in exactly one place conceptually
 * (atlas-core, for anchors) and one place mechanically (the GPU, for points), and it means
 * relocating an island on a rare persisted layout change costs one matrix rather than a re-upload
 * of 72 MB.
 */

export interface IslandViewOptions {
  readonly island: Island;
  readonly data: PointMapData;
  readonly bindings: readonly SegmentBinding[];
  readonly indexOf: ReadonlyMap<AnchorId, number>;
  readonly anchors: readonly Anchor[];
}

export class IslandView {
  readonly island: Island;
  readonly points: Points;
  readonly material: PointMaterial;
  readonly state: SegmentStateTable;
  readonly pointCount: number;
  readonly gpuBytes: number;

  /** Built one frame after the first render, so it stays out of time-to-first-render. */
  private occupancy: OccupancyGrid | null = null;

  constructor(options: IslandViewOptions) {
    const { island, data } = options;
    this.island = island;
    this.pointCount = data.header.pointCount;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.position, 3));
    // `normalized: true` maps the byte to 0..1 in the shader with no CPU work. Alpha is the
    // reconstruction's per-point confidence, which the .opm header asserts and `decodeOpm`
    // checks, because the point material reads it as confidence and not as opacity.
    geometry.setAttribute('aColor', new BufferAttribute(data.color, 4, true));
    // Uint16 non-normalized arrives in GLSL as a float 0..65535 through `vertexAttribPointer`.
    // A segment id is a small integer and this avoids a second float buffer over four million
    // points, which would be 16 MB of VRAM to say what two bytes already say.
    //
    // Two components since OPM/2: channel 0 is the segment id and channel 1 is a flags word
    // this binding does not read. ADR-0010 D4 says outright that whether bit 0 removes the
    // silhouette fringing "is the thing to measure before writing it", so consuming it here
    // would be inventing an appearance for a number nobody has looked at.
    geometry.setAttribute('aTags', new BufferAttribute(data.tags, 2));

    // Set the bounding sphere from the header rather than letting three compute it. Three's
    // computation is a full pass over the position array; the writer already knows the answer.
    const min = data.header.bounds.min;
    const max = data.header.bounds.max;
    const centre = new Vector3(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    );
    const radius = Math.hypot(max[0] - centre.x, max[1] - centre.y, max[2] - centre.z);
    geometry.boundingSphere = new Sphere(centre, radius);

    this.state = new SegmentStateTable(data.header, options.bindings, {
      indexOf: options.indexOf,
      anchors: options.anchors,
    });

    // The state table owns the array and the texture wraps it, so `SegmentStateTable.update`
    // writes straight into the texture's backing store. A recomposition costs one 1 KB upload.
    this.material = new PointMaterial(
      {
        captureFovYDeg: data.header.viewpoint.fovYDeg,
        sourceImageHeight: data.header.sourceImage.height,
        viewpointLocal: data.header.viewpoint.position,
        footprintRadiusLocal: island.footprintRadiusLocal,
        islandScale: island.placement.scale,
      },
      this.state.data,
    );

    this.points = new Points(geometry, this.material.material);
    this.points.name = island.islandId;
    this.points.frustumCulled = true;
    this.points.position.set(
      island.placement.position.x,
      island.placement.position.y,
      island.placement.position.z,
    );
    this.points.rotation.set(0, island.placement.yaw, 0);
    this.points.scale.setScalar(island.placement.scale);
    this.points.updateMatrix();
    this.points.matrixAutoUpdate = false;

    this.gpuBytes = data.position.byteLength + data.color.byteLength + data.tags.byteLength;
  }

  get occupancyGrid(): OccupancyGrid | null {
    return this.occupancy;
  }

  /** Deferred, and the caller decides when. See the note in `containment.ts`. */
  buildOccupancy(data: PointMapData): OccupancyGrid {
    if (this.occupancy !== null) return this.occupancy;
    this.occupancy = buildOccupancyGrid(data, this.island.footprintRadiusLocal);
    return this.occupancy;
  }

  /**
   * Per frame. One texture upload only when a byte of the epistemic state actually changed,
   * which on a still frame is never.
   */
  update(
    frame: PointFrameUniforms,
    emphasis: EmphasisBuffers,
    islandEmphasis: number,
    focusedAnchorIndex: number | null,
  ): void {
    this.material.setFrame(frame, islandEmphasis);
    if (this.state.update(emphasis, islandEmphasis, focusedAnchorIndex)) {
      this.material.flagStateDirty();
    }
  }

  applyAppearance(a: PointAppearanceSettings): void {
    this.material.applyAppearance(a);
  }

  /**
   * A detail budget, and the caveat that makes it unusable on this fixture.
   *
   * Spark exposes `SparkRenderer.lodSplatCount` and PlayCanvas exposes a cross-asset
   * `splatBudget`; the equivalent for a plain point cloud is a per-island draw range. It only
   * works if a PREFIX of the buffer is a spatially uniform subsample. It is not here:
   * scene-synth writes points in raster scan order, so a prefix is the top of the image, which
   * is sky and facade. Shipping this would need the writer to emit a shuffled or Morton-ordered
   * buffer, which is a change to scene-synth rather than to this binding.
   *
   * Left in, off by default, and documented, because a silently wrong LoD would corrupt every
   * number in the bake-off.
   */
  setDrawRange(count: number): void {
    this.points.geometry.setDrawRange(0, Math.min(count, this.pointCount));
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

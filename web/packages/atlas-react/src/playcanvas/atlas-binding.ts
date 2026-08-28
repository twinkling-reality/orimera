import * as pc from 'playcanvas';
import type {
  AnchorTable,
  AtlasScene,
  CameraPose,
  EmphasisBuffers,
  FocusState,
  Island,
  IslandId,
  TierState,
  ViewManifest,
} from '@orimera/atlas-core';
import {
  DISSOLVE_BAND_FRACTION,
  EMPTY_TIER_STATE,
  INITIAL_FOCUS_STATE,
  applyViewManifestInto,
  atlasVec3,
  buildAnchorTable,
  localToAtlas,
  localVec3,
  neutralEmphasis,
  occurrenceNormalizer,
  resolveFocus,
  resolveTiers,
} from '@orimera/atlas-core';
import { AnchorOverlay } from './anchor-overlay.js';
import { FirstPersonControls, type CameraState, type InputMode } from './controls.js';
import type { PointMap } from './opm.js';
import type { PointCloud } from './point-cloud.js';
import { createPointCloud } from './point-cloud.js';
import { defaultSemanticsFor } from './semantics.js';

/**
 * The PlayCanvas binding for the Atlas.
 *
 * ONE SCENE, FOR THE WHOLE SESSION. The `AtlasScene` handed in here is never replaced. Tier
 * changes, view manifests and camera moves are all transformations over it. There is no "enter
 * scene" and no "return to Atlas" in this file, and there must never be one.
 *
 * WHAT THIS FILE DOES NOT OWN. Every rule about what the world should look like lives in
 * atlas-core: which tier an island is at, which anchor has focus, what emphasis each anchor
 * carries, where an island sits. This module converts those answers into PlayCanvas objects and
 * nothing more. That split is what makes ADR-0003 a two-package decision rather than a front-end
 * rewrite, and it is worth being strict about: if a rule is being decided here, it is in the wrong
 * package.
 */

export interface IslandVisual {
  readonly island: Island;
  readonly entity: pc.Entity;
  readonly cloud: PointCloud;
  /** Reused so the per-frame uniform write allocates nothing. */
  readonly uIsland: Float32Array;
  readonly uPoint: Float32Array;
}

export interface AtlasBindingOptions {
  readonly canvas: HTMLCanvasElement;
  readonly overlayParent: HTMLElement;
  readonly scene: AtlasScene;
  /** One point map per island. Islands with no map render as anchors only. */
  readonly pointMaps: ReadonlyMap<IslandId, PointMap>;
  readonly deviceTypes?: readonly string[];
  readonly blend?: boolean;
  readonly sizeGain?: number;
  readonly maxSizePx?: number;
  readonly fov?: number;
  readonly overlay?: boolean;
}

export interface FrameReport {
  readonly dt: number;
  readonly mode: InputMode;
  readonly tier: TierState;
  readonly focusedIndex: number | null;
}

/** A tiny structural check that the presentation transform survived the trip into the engine. */
export interface PlacementCheck {
  readonly islandId: IslandId;
  readonly maxErrorMetres: number;
}

export class AtlasBinding {
  readonly app: pc.AppBase;
  readonly device: pc.GraphicsDevice;
  readonly camera: pc.Entity;
  readonly controls: FirstPersonControls;
  readonly overlay: AnchorOverlay | null;
  readonly table: AnchorTable;
  readonly emphasis: EmphasisBuffers;
  readonly islands: readonly IslandVisual[];
  readonly scene: AtlasScene;

  private tierState: TierState = EMPTY_TIER_STATE;
  private focusState: FocusState = INITIAL_FOCUS_STATE;
  private readonly normalizer: number;
  private readonly pose: { position: pc.Vec3; rotation: pc.Quat } = {
    position: new pc.Vec3(),
    rotation: new pc.Quat(),
  };
  private readonly qYaw = new pc.Quat();
  private readonly qPitch = new pc.Quat();
  private elapsed = 0;

  onFrame: ((report: FrameReport) => void) | null = null;

  private constructor(
    app: pc.AppBase,
    camera: pc.Entity,
    controls: FirstPersonControls,
    overlay: AnchorOverlay | null,
    scene: AtlasScene,
    table: AnchorTable,
    islands: readonly IslandVisual[],
  ) {
    this.app = app;
    this.device = app.graphicsDevice;
    this.camera = camera;
    this.controls = controls;
    this.overlay = overlay;
    this.scene = scene;
    this.table = table;
    this.islands = islands;
    this.emphasis = neutralEmphasis(table);
    this.normalizer = occurrenceNormalizer(table.anchors);
  }

  static async create(options: AtlasBindingOptions): Promise<AtlasBinding> {
    const device = await pc.createGraphicsDevice(options.canvas, {
      deviceTypes: [...(options.deviceTypes ?? ['webgl2'])],
      antialias: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
    });

    const app = new pc.AppBase(options.canvas);
    const appOptions = new pc.AppOptions();
    appOptions.graphicsDevice = device;
    appOptions.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem];
    appOptions.resourceHandlers = [];
    app.init(appOptions);
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);

    const camera = new pc.Entity('atlas-camera');
    camera.addComponent('camera', {
      fov: options.fov ?? 70,
      nearClip: 0.08,
      farClip: 1200,
      clearColor: new pc.Color(0.055, 0.062, 0.086, 1),
    });
    app.root.addChild(camera);

    const table = buildAnchorTable(options.scene);
    const visuals: IslandVisual[] = [];

    for (const island of options.scene.islands) {
      const entity = new pc.Entity(`island:${island.islandId}`);
      applyPlacement(entity, island);

      const map = options.pointMaps.get(island.islandId);
      let cloud: PointCloud | null = null;
      if (map !== undefined) {
        cloud = createPointCloud({
          device,
          map,
          semantics: defaultSemanticsFor(map.header),
          ...(options.sizeGain === undefined ? {} : { sizeGain: options.sizeGain }),
          ...(options.maxSizePx === undefined ? {} : { maxSizePx: options.maxSizePx }),
          ...(options.blend === undefined ? {} : { blend: options.blend }),
        });
        const instance = new pc.MeshInstance(cloud.mesh, cloud.material, entity);
        entity.addComponent('render', { meshInstances: [instance] });
      }

      app.root.addChild(entity);

      if (cloud !== null) {
        visuals.push({
          island,
          entity,
          cloud,
          uIsland: new Float32Array([
            1,
            cloud.footprintRadiusLocal,
            cloud.footprintRadiusLocal * (1 - DISSOLVE_BAND_FRACTION),
            island.placement.scale,
          ]),
          uPoint: new Float32Array([
            options.sizeGain ?? cloud.defaultSizeGain,
            options.maxSizePx ?? cloud.defaultMaxSizePx,
            900,
            0,
          ]),
        });
      }
    }

    // Start at the first island's viewpoint, FACING THE WAY THE CAMERA FACED. A single-photo
    // island has exactly one viewpoint and observed surfaces on one side only, so standing at the
    // viewpoint looking the other way puts the user inside the void with the shell behind them.
    //
    // The yaw is the island's placement yaw and nothing else. `CAPTURE_FORWARD_LOCAL` is -Z, both
    // engines put the camera's forward on -Z, and `applyPlacement` writes the same yaw onto the
    // island, so a camera yaw equal to the placement yaw looks straight down the capture's own
    // forward direction. Adding half a turn here is the obvious mistake and it is silent: the
    // world still renders, it is just behind you.
    const first = options.scene.islands[0];
    const start: CameraState =
      first === undefined
        ? { x: 0, y: 1.62, z: 0, yaw: 0, pitch: 0 }
        : (() => {
            const p = localToAtlas(first.placement, first.viewpointLocal);
            return { x: p.x, y: p.y, z: p.z, yaw: first.placement.yaw, pitch: 0 };
          })();

    const controls = new FirstPersonControls(options.canvas, start);
    const overlay =
      options.overlay === false ? null : new AnchorOverlay(options.overlayParent);

    return new AtlasBinding(app, camera, controls, overlay, options.scene, table, visuals);
  }

  /**
   * Verify that the engine's world transform reproduces atlas-core's `localToAtlas` exactly.
   *
   * Worth doing once at startup rather than trusting a convention comment. An island turned the
   * wrong way is a hole, because a 2.5D shell has observed surfaces on one side only, and a sign
   * error in a yaw is not visible until someone walks round the back.
   */
  verifyPlacements(): PlacementCheck[] {
    const probes = [
      localVec3(1, 0, 0),
      localVec3(0, 0, -1),
      localVec3(3.5, 1.2, -7.25),
    ];
    const out: PlacementCheck[] = [];
    const v = new pc.Vec3();
    for (const visual of this.islands) {
      let worst = 0;
      for (const probe of probes) {
        const expected = localToAtlas(visual.island.placement, probe);
        v.set(probe.x, probe.y, probe.z);
        visual.entity.getWorldTransform().transformPoint(v, v);
        worst = Math.max(worst, Math.hypot(v.x - expected.x, v.y - expected.y, v.z - expected.z));
      }
      out.push({ islandId: visual.island.islandId, maxErrorMetres: worst });
    }
    return out;
  }

  /** Apply a view manifest. One tight numeric loop, no scene-graph mutation, safe on every hover. */
  applyManifest(manifest: ViewManifest): void {
    applyViewManifestInto(this.table, manifest, this.emphasis, this.scene.stateVersion);
  }

  /** Reset to the neutral frame: nothing emphasised, nothing muted. */
  clearManifest(): void {
    const neutral = neutralEmphasis(this.table);
    this.emphasis.anchorEmphasis.set(neutral.anchorEmphasis);
    this.emphasis.anchorLevel.set(neutral.anchorLevel);
    this.emphasis.anchorInteractable.set(neutral.anchorInteractable);
    this.emphasis.anchorLabelable.set(neutral.anchorLabelable);
    this.emphasis.islandEmphasis.set(neutral.islandEmphasis);
    this.emphasis.islandLevel.set(neutral.islandLevel);
  }

  cameraPose(): CameraPose {
    const s = this.controls.state;
    return { position: atlasVec3(s.x, s.y, s.z), forward: this.controls.forward() };
  }

  /**
   * One frame of Atlas logic. Called from the engine's update, before it renders.
   *
   * The order matters and is the same order the interaction model describes: move, decide
   * representation density, decide attention, then draw the overlay from those decisions. The
   * overlay never decides anything.
   */
  update(dt: number, nowMs: number): void {
    this.elapsed += dt;
    this.controls.update(dt);

    const s = this.controls.state;
    this.pose.position.set(s.x, s.y, s.z);
    this.camera.setPosition(this.pose.position);
    this.qYaw.setFromAxisAngle(pc.Vec3.UP, (s.yaw * 180) / Math.PI);
    this.qPitch.setFromAxisAngle(pc.Vec3.RIGHT, (s.pitch * 180) / Math.PI);
    this.pose.rotation.mul2(this.qYaw, this.qPitch);
    this.camera.setRotation(this.pose.rotation);

    const cameraAtlas = atlasVec3(s.x, s.y, s.z);
    this.tierState = resolveTiers(this.scene, this.table, cameraAtlas, this.tierState);

    // Representation density, as one uniform write per island. No material swap, no scene-graph
    // mutation: that is the performance contract, and it is what makes emphasis previewable on
    // every hover.
    const projScale =
      this.device.height / (2 * Math.tan(((this.camera.camera?.fov ?? 70) * Math.PI) / 360));

    for (let i = 0; i < this.islands.length; i += 1) {
      const visual = this.islands[i]!;
      const tier = this.tierState.tier.get(visual.island.islandId) ?? 0;
      const islandIndex = this.table.islandIndexOf.get(visual.island.islandId);
      const emphasis =
        islandIndex === undefined ? 1 : (this.emphasis.islandEmphasis[islandIndex] ?? 1);

      // Tier is representation DENSITY, never scene identity. A tier 0 island is still in the
      // scene and still emphasised; it just carries less of itself.
      const density = tier === 3 ? 1 : tier === 2 ? 0.7 : tier === 1 ? 0.35 : 0.12;

      visual.uIsland[0] = Math.max(0.001, emphasis / 0.45) * density;
      visual.uPoint[2] = projScale;
      visual.uPoint[3] = this.elapsed;
      visual.cloud.material.setParameter('uIsland', visual.uIsland);
      visual.cloud.material.setParameter('uPoint', visual.uPoint);
    }

    const resolution = resolveFocus(
      {
        table: this.table,
        emphasis: this.emphasis,
        camera: this.cameraPose(),
        nowMs,
        occurrenceNormalizer: this.normalizer,
      },
      this.focusState,
    );
    this.focusState = resolution.state;

    const cameraComponent = this.camera.camera;
    if (this.overlay !== null && cameraComponent !== undefined && cameraComponent !== null) {
      this.overlay.update({
        table: this.table,
        emphasis: this.emphasis,
        camera: cameraComponent,
        focusedIndex: this.focusState.focusedIndex,
        widthCss: this.device.canvas.clientWidth,
        heightCss: this.device.canvas.clientHeight,
        capturedAt: this.scene.islands[0]?.createdAt ?? Date.now(),
      });
    }

    this.onFrame?.({
      dt,
      mode: this.controls.mode,
      tier: this.tierState,
      focusedIndex: this.focusState.focusedIndex,
    });
  }

  destroy(): void {
    this.controls.destroy();
    this.overlay?.destroy();
    for (const visual of this.islands) visual.cloud.destroy();
    this.app.destroy();
  }
}

/**
 * The presentation transform, and only the presentation transform.
 *
 * Islands are never pitched or rolled, so the up vector stays globally shared. That is why this
 * writes a single yaw rather than a quaternion: a quaternion would make an illegal orientation
 * representable, and atlas-core deliberately does not offer one.
 */
function applyPlacement(entity: pc.Entity, island: Island): void {
  const p = island.placement;
  entity.setLocalPosition(p.position.x, p.position.y, p.position.z);
  entity.setLocalEulerAngles(0, (p.yaw * 180) / Math.PI, 0);
  entity.setLocalScale(p.scale, p.scale, p.scale);
}

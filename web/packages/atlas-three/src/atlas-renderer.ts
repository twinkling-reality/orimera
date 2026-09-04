import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type {
  AnchorTable,
  AtlasScene,
  EmphasisBuffers,
  FocusResolution,
  FocusState,
  Island,
  TierState,
  ViewManifest,
} from '@exulanica/atlas-core';
import {
  EMPTY_TIER_STATE,
  INITIAL_FOCUS_STATE,
  applyViewManifestInto,
  atlasVec3,
  forwardFromYawPitch,
  neutralEmphasis,
  occurrenceNormalizer,
  resolveFocus,
  resolveTiers,
} from '@exulanica/atlas-core';
import { PointerLook } from './controls/pointer-look.js';
import type { IslandGround } from './controls/walker.js';
import { Walker } from './controls/walker.js';
import { FrameMeter } from './instrumentation.js';
import type { PointMapData } from './opm.js';
import { AnchorOverlay } from './overlay/anchor-overlay.js';
import type { NameResolver } from './overlay/anchor-overlay.js';
import { IslandView } from './render/island-view.js';
import type { PointAppearanceSettings } from './render/point-material.js';
import { DEFAULT_APPEARANCE } from './render/point-material.js';
import { PresenceMarkers } from './render/presence-markers.js';
import type { PresenceContentResolver } from './render/presence-markers.js';
import type { SegmentBinding } from './semantic-state.js';

/**
 * ONE canvas, ONE scene graph, ONE camera, ONE render loop, for the whole session.
 *
 * interaction-model.md 1.1 is a decision with five mechanical consequences, and this class is
 * where four of them land: representation density changes rather than scene identity, the Atlas
 * Map is a camera pose, recomposition is a per-object uniform change, and processing formation
 * happens where the island will be. None of those is implementable on top of a renderer that
 * loads and unloads scenes, which is why `addIsland` appends to a live graph and there is no
 * `load`, no `enter` and no `dispose the world` in this API.
 *
 * N islands in one canvas is the essential requirement, not a stretch goal: the Atlas is
 * continuous, and every island is resident at all times at whatever representation tier its
 * distance earns.
 */

export interface ComfortSettings {
  /** 60 to 90, default 70 (interaction-model.md 2.4). */
  fieldOfView: number;
  vignette: 'off' | 'subtle' | 'strong';
  /** Read from `prefers-reduced-motion`, never asked for in onboarding. */
  reducedMotion: boolean;
}

export const DEFAULT_COMFORT: ComfortSettings = {
  fieldOfView: 70,
  vignette: 'subtle',
  reducedMotion: false,
};

export interface AtlasRendererOptions {
  readonly container: HTMLElement;
  readonly scene: AtlasScene;
  readonly table: AnchorTable;
  readonly resolveName: NameResolver;
  readonly resolvePresence: PresenceContentResolver;
  readonly comfort?: Partial<ComfortSettings>;
  /** Off in a bake-off run: 20k extra points would be noise inside a 4M measurement. */
  readonly betweenSpaceMotes?: boolean;
  readonly pixelRatioCap?: number;
}

export interface AtlasFrameReport {
  readonly dtSeconds: number;
  readonly tiers: TierState;
  readonly focus: FocusResolution;
  readonly overlay: { drawn: number; chevrons: number; overflow: number };
  readonly boundaryPressure: number;
  readonly speedFraction: number;
}

export class AtlasRenderer {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly three = new Scene();
  readonly look: PointerLook;
  readonly walker: Walker;
  readonly overlay: AnchorOverlay;
  readonly meter = new FrameMeter();
  readonly presence: PresenceMarkers;

  comfort: ComfortSettings;
  appearance: PointAppearanceSettings = { ...DEFAULT_APPEARANCE };

  private readonly container: HTMLElement;
  private readonly atlas: AtlasScene;
  private readonly table: AnchorTable;
  private readonly views = new Map<string, IslandView>();
  private readonly grounds: IslandGround[] = [];
  private readonly emphasis: EmphasisBuffers;
  private readonly occurrenceNorm: number;
  private readonly fogColor = new Color(0x0b0d12);
  private readonly reticle: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private readonly resume: HTMLButtonElement;
  private readonly frameVec = new Vector3();

  private manifest: ViewManifest | null = null;
  private tiers: TierState = EMPTY_TIER_STATE;
  private focusState: FocusState = INITIAL_FOCUS_STATE;
  private pinned: number[] = [];
  private running = false;
  private rafId = 0;
  private startedAt = performance.now();
  private motes: Points | null = null;
  /**
   * A scripted camera pose that replaces the walker for this frame.
   *
   * This is the mechanism Locate travel and the Atlas Map need: both are "the same scene with a
   * different camera pose" rather than a different view, so the rig has to accept an authored
   * pose without the walker fighting it. It is also what lets the bake-off drive an identical,
   * deterministic camera path through every rung, which is the only way two renderers'
   * frame-time numbers describe the same workload.
   */
  scriptedPose: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;
  private deferredOccupancy: Array<() => void> = [];

  constructor(options: AtlasRendererOptions) {
    this.container = options.container;
    this.atlas = options.scene;
    this.table = options.table;
    this.comfort = { ...DEFAULT_COMFORT, ...options.comfort };
    if (options.comfort?.reducedMotion === undefined) {
      this.comfort.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    this.renderer = new WebGLRenderer({
      // Anti-aliasing does nothing useful for a point cloud drawn with stochastic alpha and
      // costs real bandwidth at 4M points, so it is off deliberately rather than by default.
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      // The default depth buffer is required: the whole material is opaque and depth-written.
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.pixelRatioCap ?? 2));
    this.renderer.setClearColor(this.fogColor, 1);
    this.container.appendChild(this.renderer.domElement);
    this.three.background = this.fogColor;

    this.camera = new PerspectiveCamera(this.comfort.fieldOfView, 1, 0.08, 3000);
    this.camera.rotation.order = 'YXZ';

    this.look = new PointerLook(this.renderer.domElement);
    this.walker = new Walker(this.look);
    this.emphasis = neutralEmphasis(this.table);
    this.occurrenceNorm = occurrenceNormalizer(this.table.anchors);

    this.overlay = new AnchorOverlay(this.container, options.resolveName);
    this.presence = new PresenceMarkers(this.table, options.resolvePresence);
    this.three.add(this.presence.group);

    this.reticle = document.createElement('div');
    this.reticle.className = 'atlas-reticle';
    this.container.appendChild(this.reticle);

    this.vignette = document.createElement('div');
    this.vignette.className = 'atlas-vignette';
    this.container.appendChild(this.vignette);

    // Resume must be a REAL click target and never an automatic retry, because re-locking
    // requires transient activation (interaction-model.md 2.2). It is a <button> so the
    // keyboard route works and the accessibility tree has something to say.
    this.resume = document.createElement('button');
    this.resume.className = 'atlas-resume';
    this.resume.type = 'button';
    this.resume.textContent = 'Click to look around. Escape releases the mouse.';
    this.resume.addEventListener('click', () => void this.look.requestLock());
    this.container.appendChild(this.resume);

    this.look.onModeChange((mode) => {
      this.resume.classList.toggle('hidden', mode === 'traverse');
      this.reticle.classList.toggle('dimmed', mode === 'converse');
    });

    if (options.betweenSpaceMotes === true) this.addBetweenSpaceMotes();

    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  /**
   * Add one island's point map to the LIVE scene graph.
   *
   * Never removes anything, never rebuilds anything else, and returns as soon as the buffers are
   * attached. The occupancy grid is queued rather than built, so it cannot land inside
   * time-to-first-meaningful-render; call `drainDeferredWork` once the first frame is on screen.
   */
  addIsland(island: Island, data: PointMapData, bindings: readonly SegmentBinding[]): IslandView {
    const view = new IslandView({
      island,
      data,
      bindings,
      indexOf: this.table.indexOf,
      anchors: this.table.anchors,
    });
    view.applyAppearance(this.appearance);
    this.views.set(island.islandId, view);
    this.three.add(view.points);
    this.deferredOccupancy.push(() => {
      this.grounds.push({ island, grid: view.buildOccupancy(data) });
    });
    return view;
  }

  /** Run the work that was deliberately kept out of the first frame. Returns its cost in ms. */
  drainDeferredWork(): number {
    const t0 = performance.now();
    for (const job of this.deferredOccupancy) job();
    this.deferredOccupancy = [];
    return performance.now() - t0;
  }

  get islandViews(): ReadonlyMap<string, IslandView> {
    return this.views;
  }

  /**
   * Apply a view manifest. This is the whole of recomposition.
   *
   * One tight numeric loop over anchors into caller-owned buffers, then at most one 1 KB texture
   * upload per island. No geometry moves, no material is swapped, no node is added or removed,
   * and the camera does not move: the manifest type has no field that could express any of it.
   */
  applyManifest(manifest: ViewManifest | null): void {
    this.manifest = manifest;
    if (manifest === null) {
      const neutral = neutralEmphasis(this.table);
      this.emphasis.anchorEmphasis.set(neutral.anchorEmphasis);
      this.emphasis.anchorLevel.set(neutral.anchorLevel);
      this.emphasis.anchorInteractable.set(neutral.anchorInteractable);
      this.emphasis.anchorLabelable.set(neutral.anchorLabelable);
      this.emphasis.islandEmphasis.set(neutral.islandEmphasis);
      this.emphasis.islandLevel.set(neutral.islandLevel);
      this.pinned = [];
      return;
    }
    applyViewManifestInto(this.table, manifest, this.emphasis, this.atlas.stateVersion);
    this.pinned = manifest.focusCandidates
      .map((id) => this.table.indexOf.get(id))
      .filter((i): i is number => i !== undefined);
  }

  placeWalkerAtViewpoint(island: Island): void {
    const p = island.placement;
    const v = island.viewpointLocal;
    const c = Math.cos(p.yaw);
    const s = Math.sin(p.yaw);
    this.walker.placeAt(
      p.position.x + v.x * p.scale * c + v.z * p.scale * s,
      p.position.y + v.y * p.scale,
      p.position.z - v.x * p.scale * s + v.z * p.scale * c,
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = performance.now();
    this.meter.reset();
    const loop = (now: number): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** One frame. Everything below runs every frame; nothing below allocates. */
  frame(now: number): AtlasFrameReport {
    const dt = this.meter.tick(now);

    let walk;
    if (this.scriptedPose === null) {
      walk = this.walker.update(dt, this.grounds);
      this.camera.position.set(this.walker.x, this.walker.y, this.walker.z);
      this.camera.rotation.y = this.look.yaw;
      this.camera.rotation.x = this.look.pitch;
    } else {
      const p = this.scriptedPose;
      this.walker.placeAt(p.x, p.y, p.z);
      this.look.yaw = p.yaw;
      this.look.pitch = p.pitch;
      this.camera.position.set(p.x, p.y, p.z);
      this.camera.rotation.y = p.yaw;
      this.camera.rotation.x = p.pitch;
      walk = { boundaryPressure: 0, speedFraction: 1, held: false };
    }
    if (this.camera.fov !== this.comfort.fieldOfView) {
      this.camera.fov = this.comfort.fieldOfView;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();

    const cameraAtlas = atlasVec3(this.walker.x, this.walker.y, this.walker.z);
    this.tiers = resolveTiers(this.atlas, this.table, cameraAtlas, this.tiers);

    // The reticle direction, and the ONLY direction the focus solver ever sees. Pointer Lock
    // freezes clientX/clientY, so there is no cursor to hover with and screen centre is the
    // only targeting input that exists.
    const focus = resolveFocus(
      {
        table: this.table,
        emphasis: this.emphasis,
        camera: {
          position: cameraAtlas,
          forward: forwardFromYawPitch(this.look.atlasForwardYaw(), this.look.pitch),
        },
        nowMs: now,
        occurrenceNormalizer: this.occurrenceNorm,
      },
      this.focusState,
    );
    this.focusState = focus.state;

    const motion = this.comfort.reducedMotion ? 0 : 1;
    const frameUniforms = {
      viewportHeightPx: this.renderer.domElement.height,
      tanHalfFov: Math.tan((this.camera.fov * Math.PI) / 360),
      fogNear: 26,
      fogFar: 460,
      fogColor: this.frameVec.set(this.fogColor.r, this.fogColor.g, this.fogColor.b),
      timeSeconds: (now - this.startedAt) / 1000,
      motion,
    };

    for (const view of this.views.values()) {
      const islandIndex = this.table.islandIndexOf.get(view.island.islandId);
      const islandEmphasis =
        islandIndex === undefined ? 1 : (this.emphasis.islandEmphasis[islandIndex] ?? 1);
      view.update(frameUniforms, this.emphasis, islandEmphasis, focus.focused?.index ?? null);
    }

    this.presence.update(this.emphasis, focus.focused?.index ?? null);

    const overlay = this.overlay.update({
      table: this.table,
      emphasis: this.emphasis,
      camera: this.camera,
      width: this.container.clientWidth,
      height: this.container.clientHeight,
      focused: focus.focused,
      pinned: this.pinned,
      mode: this.look.mode,
    });

    // "Vignettes that darken or completely occlude the edges of the screen when movement occurs
    // in order to limit the amount of visible optic flow." A comfort requirement, not a look.
    // https://developers.meta.com/horizon/resources/locomotion-design-reduce-optic-flow/
    const strength = this.comfort.vignette === 'off' ? 0 : this.comfort.vignette === 'strong' ? 1 : 0.55;
    this.vignette.style.opacity = String(
      Math.min(1, strength * Math.max(walk.speedFraction, walk.boundaryPressure)),
    );

    this.renderer.render(this.three, this.camera);

    return {
      dtSeconds: dt,
      tiers: this.tiers,
      focus,
      overlay,
      boundaryPressure: walk.boundaryPressure,
      speedFraction: walk.speedFraction,
    };
  }

  applyAppearance(a: PointAppearanceSettings): void {
    this.appearance = a;
    for (const view of this.views.values()) view.applyAppearance(a);
  }

  get activeManifest(): ViewManifest | null {
    return this.manifest;
  }

  /** Bytes this binding uploaded. A lower bound on VRAM, and labelled as one. See instrumentation. */
  uploadedBytes(): number {
    let total = 0;
    for (const view of this.views.values()) total += view.gpuBytes;
    return total;
  }

  private addBetweenSpaceMotes(): void {
    // "The between-space is not empty" and it must be LOW FREQUENCY: large soft gradients,
    // sparse motes, no high-contrast tiling ground texture, because optic flow from a noisy
    // ground plane is a comfort defect. 12k motes over the whole atlas is deliberately sparse.
    const count = 12_000;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 40 + Math.random() * 240;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.random() * 40 - 4;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.motes = new Points(
      geometry,
      new PointsMaterial({
        size: 1.4,
        sizeAttenuation: false,
        color: 0x5a6b86,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.motes.frustumCulled = false;
    this.three.add(this.motes);
  }

  private readonly onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    this.presence.dispose();
    this.overlay.dispose();
    this.look.dispose();
    this.walker.dispose();
    this.meter.dispose();
    this.motes?.geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.reticle.remove();
    this.vignette.remove();
    this.resume.remove();
  }
}

/**
 * Mounting the renderer. The one file in this package that knows a renderer exists.
 *
 * ADR-0003 resolved to PlayCanvas Engine 2.21.4, and `@orimera/atlas-react` is the binding.
 * Everything engine-specific lives behind that package, which is what makes a renderer switch a
 * two-package change; nothing here names `playcanvas`, and `.dependency-cruiser.cjs` would fail
 * the build if it did.
 *
 * **No point maps are passed, and that is the honest state.** `AtlasBinding` takes one point map
 * per island and renders islands without one as anchors only. Nothing reconstructs yet, so the
 * map is empty and every region is anchors in space. That is rung 4 rendered as rung 4.
 *
 * It is also the thesis under test. Reconstruction quality never participates in the truth
 * guarantee: a region with no geometry at all still resolves every citation to the exact
 * original photograph, and this file is where that stops being a claim in a document.
 *
 * **The placement check runs at startup and its result is reported, not swallowed.** A sign error
 * in a yaw is invisible until somebody walks round the back of a region, and the binding offers
 * a check for exactly that. Running it and discarding the answer would be the same as not
 * running it.
 */

import type { AtlasScene, IslandId } from '@orimera/atlas-core';
import type {
  PresentationTheme,
  WorldArtProfile,
  WorldStyleParameters,
} from '@orimera/presentation';
import type { FrameReport, PlacementCheck, PointMap } from '@orimera/atlas-react/playcanvas';
import { AtlasBinding } from '@orimera/atlas-react/playcanvas';

export interface MountedAtlas {
  readonly binding: AtlasBinding;
  readonly placements: readonly PlacementCheck[];
  dispose(): void;
}

/** No island has geometry yet. Empty, rather than a map of empty point maps. */
const NO_POINT_MAPS: ReadonlyMap<IslandId, PointMap> = new Map();

export async function mountAtlas(
  canvas: HTMLCanvasElement,
  overlayParent: HTMLElement,
  scene: AtlasScene,
  onFrame?: (report: FrameReport) => void,
  presentation?: {
    readonly theme: PresentationTheme;
    readonly fieldOfView: number;
    readonly mouseSensitivity: number;
    readonly artProfile?: WorldArtProfile;
    readonly artProfileParameters?: WorldStyleParameters;
  },
): Promise<MountedAtlas> {
  const binding = await AtlasBinding.create({
    canvas,
    overlayParent,
    scene,
    pointMaps: NO_POINT_MAPS,
    ...(presentation === undefined
      ? {}
      : {
          theme: presentation.theme,
          fov: presentation.fieldOfView,
          sensitivityMultiplier: presentation.mouseSensitivity,
          ...(presentation.artProfile === undefined ? {} : { artProfile: presentation.artProfile }),
          ...(presentation.artProfileParameters === undefined
            ? {}
            : { artProfileParameters: presentation.artProfileParameters }),
        }),
  });
  canvas.dataset.worldProfile = binding.composedWorld.profileId;
  canvas.dataset.worldTopology = binding.topology.topologyDigest;
  canvas.dataset.worldModules = String(binding.topology.instances.length);

  if (onFrame !== undefined) binding.onFrame = onFrame;
  // The engine drives the clock. The binding's own update runs before the render, which is the
  // order the interaction model describes: move, decide density, decide attention, then draw.
  binding.app.on('update', (dt: number) => {
    binding.update(dt, performance.now());
  });
  binding.app.start();

  return {
    binding,
    placements: binding.verifyPlacements(),
    dispose: () => {
      delete canvas.dataset.worldProfile;
      delete canvas.dataset.worldTopology;
      delete canvas.dataset.worldModules;
      binding.destroy();
    },
  };
}

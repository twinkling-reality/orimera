import * as pc from 'playcanvas';
import type { AtlasScene, IslandId, ResidencyStage } from '@orimera/atlas-core';
import {
  atlasLandscapeHeight,
  localToAtlas,
  sourceFirstCardLocalPosition,
} from '@orimera/atlas-core';
import {
  DAWN_THEME,
  ORIGIN_LANDSCAPE,
  unitRgb,
  type PresentationTheme,
  type WorldArtProfile,
} from '@orimera/presentation';

export interface SourceFirstGrove {
  readonly entity: pc.Entity;
  setTheme(theme: PresentationTheme): void;
  setProfile(profile: WorldArtProfile): void;
  setResidency(stages: ReadonlyMap<IslandId, ResidencyStage>, map: boolean): void;
  destroy(): void;
}

function setMaterial(
  material: pc.StandardMaterial,
  diffuse: string,
  options: {
    readonly metalness?: number;
    readonly gloss?: number;
    readonly emissive?: string;
    readonly emissiveIntensity?: number;
    readonly opacity?: number;
  } = {},
): void {
  const [r, g, b] = unitRgb(diffuse);
  const [er, eg, eb] = unitRgb(options.emissive ?? '#000000');
  material.diffuse.set(r, g, b);
  material.emissive.set(er, eg, eb);
  material.emissiveIntensity = options.emissiveIntensity ?? 0;
  material.metalness = options.metalness ?? 0;
  material.gloss = options.gloss ?? 0.2;
  material.opacity = options.opacity ?? 1;
  material.blendType = material.opacity < 1 ? pc.BLEND_NORMAL : pc.BLEND_NONE;
  material.depthWrite = material.opacity >= 0.72;
  material.useLighting = true;
  material.cull = pc.CULLFACE_BACK;
  material.update();
}

function addPart(
  parent: pc.Entity,
  name: string,
  mesh: pc.Mesh,
  material: pc.Material,
  position: readonly [number, number, number],
  scale: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
): pc.Entity {
  const part = new pc.Entity(name);
  part.setLocalPosition(position[0], position[1], position[2]);
  part.setLocalScale(scale[0], scale[1], scale[2]);
  part.setLocalEulerAngles(rotation[0], rotation[1], rotation[2]);
  const instance = new pc.MeshInstance(mesh, material, part);
  instance.castShadow = material instanceof pc.StandardMaterial && material.opacity >= 0.72;
  instance.receiveShadow = true;
  part.addComponent('render', { meshInstances: [instance] });
  parent.addChild(part);
  return part;
}

/**
 * Honest source body for rung-4 regions. The lens is an explicit empty memory aperture when source
 * media is unavailable; it never substitutes decorative imagery for evidence.
 */
export function createSourceFirstGrove(
  device: pc.GraphicsDevice,
  scene: AtlasScene,
  initialProfile: WorldArtProfile = ORIGIN_LANDSCAPE,
  _theme: PresentationTheme = DAWN_THEME,
): SourceFirstGrove {
  const root = new pc.Entity('source-first-grove');
  const groups = new Map<IslandId, pc.Entity>();
  const details: pc.Entity[] = [];
  const cube = pc.Mesh.fromGeometry(
    device,
    new pc.BoxGeometry({ halfExtents: new pc.Vec3(0.5, 0.5, 0.5) }),
  );
  const orb = pc.Mesh.fromGeometry(
    device,
    new pc.SphereGeometry({ radius: 0.5, latitudeBands: 14, longitudeBands: 18 }),
  );
  const disc = pc.Mesh.fromGeometry(
    device,
    new pc.CylinderGeometry({ radius: 0.5, height: 0.16, capSegments: 36 }),
  );
  const ring = pc.Mesh.fromGeometry(
    device,
    new pc.TorusGeometry({ ringRadius: 0.42, tubeRadius: 0.045, segments: 36, sides: 10 }),
  );
  const porcelain = new pc.StandardMaterial();
  const cobalt = new pc.StandardMaterial();
  const glass = new pc.StandardMaterial();
  const signal = new pc.StandardMaterial();
  const growth = new pc.StandardMaterial();

  const setProfile = (profile: WorldArtProfile): void => {
    setMaterial(porcelain, profile.palette.stone, { gloss: 0.48 });
    setMaterial(cobalt, profile.palette.stoneShadow, {
      emissive: profile.palette.stoneShadow,
      emissiveIntensity: profile.material.emissiveStrength * 0.18,
      gloss: 0.62,
    });
    setMaterial(glass, profile.palette.paper, {
      emissive: profile.palette.paper,
      emissiveIntensity: profile.material.emissiveStrength * 0.28,
      gloss: profile.material.gloss,
      opacity: Math.max(0.28, profile.material.opacity * 0.58),
    });
    glass.cull = pc.CULLFACE_NONE;
    glass.twoSidedLighting = true;
    glass.update();
    setMaterial(signal, profile.palette.brass, {
      emissive: profile.palette.brass,
      emissiveIntensity: profile.material.emissiveStrength * 0.5,
      metalness: 0.18,
      gloss: 0.72,
    });
    setMaterial(growth, profile.palette.terrainLift, { gloss: 0.3 });
    details.forEach((detail, index) => {
      detail.enabled = index % 12 < profile.geometry.detailCount;
    });
  };

  for (const island of scene.islands) {
    if (island.rung !== 4) continue;
    const group = new pc.Entity(`source-first:${island.islandId}`);
    group.setPosition(
      island.placement.position.x,
      island.placement.position.y,
      island.placement.position.z,
    );
    group.setEulerAngles(0, (island.placement.yaw * 180) / Math.PI, 0);
    group.setLocalScale(island.placement.scale, island.placement.scale, island.placement.scale);

    const base = sourceFirstCardLocalPosition(island);
    const baseWorld = localToAtlas(island.placement, base);
    const clearing = new pc.Entity(`memory-lens:${island.islandId}`);
    clearing.setLocalPosition(
      base.x,
      atlasLandscapeHeight(baseWorld.x, baseWorld.z) - island.placement.position.y,
      base.z,
    );
    group.addChild(clearing);

    // The source surface is a recognizable optical lens rather than an unexplained blank panel.
    addPart(clearing, 'memory-platform-low', disc, porcelain, [0, 0.09, 0], [3.4, 0.58, 1.8]);
    addPart(clearing, 'memory-platform-signal', disc, cobalt, [0, 0.18, 0], [2.75, 0.2, 1.42]);
    addPart(clearing, 'memory-lens-glass', disc, glass, [0, 1.55, 0], [2.16, 0.32, 2.16], [90, 0, 0]);
    addPart(clearing, 'memory-lens-frame', ring, porcelain, [0, 1.55, 0.08], [2.55, 2.55, 2.55], [90, 0, 0]);
    addPart(clearing, 'memory-lens-vector', ring, cobalt, [0, 1.55, 0.12], [2.16, 2.16, 2.16], [90, 0, 0]);
    addPart(clearing, 'memory-lens-aperture', orb, signal, [0, 1.55, 0.18], [0.32, 0.32, 0.1]);

    // A continuous water-glass approach reads as navigation rather than a row of rocks.
    addPart(clearing, 'memory-current-bed', cube, glass, [0, 0.025, 5.25], [1.18, 0.028, 9.45]);
    for (let index = 0; index < 8; index += 1) {
      const z = 1.35 + index * 1.16;
      addPart(
        clearing,
        `memory-current:${index}`,
        orb,
        glass,
        [Math.sin(index * 1.4) * 0.12, 0.035, z],
        [0.94 - index * 0.035, 0.045, 0.58 + (index % 2) * 0.08],
        [0, Math.sin(index * 0.9) * 5, 0],
      );
    }
    addPart(clearing, 'current-signal-left', cube, signal, [-0.57, 0.045, 5.2], [0.035, 0.022, 7.7], [0, -2.5, 0]);
    addPart(clearing, 'current-signal-right', cube, cobalt, [0.57, 0.045, 5.2], [0.035, 0.022, 7.7], [0, 2.5, 0]);

    // Decorative ecology is a density-controlled layer. It never represents memories or evidence.
    for (let index = 0; index < 12; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const depth = 0.7 + Math.floor(index / 2) * 0.95;
      const plant = new pc.Entity(`garden-detail:${index}`);
      clearing.addChild(plant);
      const x = side * (1.42 + (index % 3) * 0.18);
      addPart(plant, 'stem', cube, growth, [x, 0.18, depth], [0.032, 0.36, 0.032]);
      addPart(plant, 'leaf-a', orb, growth, [x - side * 0.08, 0.3, depth], [0.17, 0.055, 0.09], [0, 0, side * 30]);
      addPart(plant, 'leaf-b', orb, growth, [x + side * 0.08, 0.38, depth], [0.17, 0.055, 0.09], [0, 0, side * -30]);
      if (index % 3 === 0) {
        addPart(plant, 'signal-bloom', orb, signal, [x, 0.49, depth], [0.065, 0.065, 0.065]);
      }
      details.push(plant);
    }

    root.addChild(group);
    groups.set(island.islandId, group);
  }
  setProfile(initialProfile);

  return {
    entity: root,
    setTheme() {},
    setProfile,
    setResidency(stages, map) {
      for (const [id, group] of groups) {
        group.enabled = !map && (stages.get(id) ?? 'stub') !== 'stub';
      }
    },
    destroy() {
      cube.destroy();
      orb.destroy();
      disc.destroy();
      ring.destroy();
      porcelain.destroy();
      cobalt.destroy();
      glass.destroy();
      signal.destroy();
      growth.destroy();
    },
  };
}

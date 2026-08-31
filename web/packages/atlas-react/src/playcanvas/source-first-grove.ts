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
import { worldMotionSeconds } from './world-field.js';
import type { SourceMediaCatalog } from './source-media.js';
import { sourceMediaForIsland } from './source-media.js';

/** The source hangs above the navigation surface; it is a view, never a wall or obstacle. */
export const SOURCE_VEIL_HEIGHT = 3.45;
const VEIL_WIDTH = 8.8;
const VEIL_HEIGHT = 6.6;

interface ShaderDesc {
  uniqueName: string;
  attributes?: Record<string, string>;
  vertexGLSL?: string;
  fragmentGLSL?: string;
}

interface MemoryVisual {
  readonly islandId: IslandId;
  readonly group: pc.Entity;
  readonly veil: pc.Entity;
  readonly material: pc.ShaderMaterial;
  readonly auraMaterial: pc.ShaderMaterial;
  readonly baseWorld: Readonly<{ x: number; y: number; z: number }>;
  readonly phase: number;
  readonly unavailable: boolean;
  profileScale: number;
  resolve: number;
  lastNowMs: number;
}

const AURA_VERTEX_GLSL = /* glsl */ `
attribute vec3 aPosition;
attribute vec2 aUv0;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec2 vUv;

void main(void) {
  vUv = aUv0;
  gl_Position = matrix_viewProjection * matrix_model * vec4(aPosition, 1.0);
}
`;

const AURA_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform sampler2D uSource;
uniform vec3 uAccent;
uniform vec3 uIvory;
uniform float uTime;
uniform float uPhase;
uniform float uAvailable;
varying vec2 vUv;

void main(void) {
  vec2 q = (vUv - 0.5) * vec2(1.0, 1.12);
  float radial = length(q);
  float breath = 0.015 * sin(atan(q.y, q.x) * 5.0 + uTime * 0.11 + uPhase);
  float body = 1.0 - smoothstep(0.15, 0.58, radial + breath);
  float centre = 1.0 - smoothstep(0.0, 0.28, radial);
  vec3 sourceBlur = (
    texture2D(uSource, vUv + vec2(0.08, 0.0)).rgb +
    texture2D(uSource, vUv - vec2(0.08, 0.0)).rgb +
    texture2D(uSource, vUv + vec2(0.0, 0.1)).rgb +
    texture2D(uSource, vUv - vec2(0.0, 0.1)).rgb +
    texture2D(uSource, vUv + vec2(0.055, 0.07)).rgb +
    texture2D(uSource, vUv - vec2(0.055, 0.07)).rgb
  ) / 6.0;
  vec3 atmosphere = mix(uAccent * 0.64, uIvory, 0.46 + centre * 0.32);
  vec3 colour = mix(atmosphere, sourceBlur, uAvailable * 0.34);
  float alpha = body * (0.12 + centre * 0.20);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(colour, alpha);
}
`;

const VEIL_VERTEX_GLSL = /* glsl */ `
attribute vec3 aPosition;
attribute vec2 aUv0;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform float uTime;
uniform float uResolve;
uniform float uPhase;
varying vec2 vUv;
varying float vCurve;

void main(void) {
  vec3 p = aPosition;
  float loose = 1.0 - uResolve;
  float centredX = aUv0.x * 2.0 - 1.0;
  float lens = (1.0 - centredX * centredX) * 0.34;
  float breathing = sin(aUv0.y * 4.8 + aUv0.x * 3.1 + uTime * 0.13 + uPhase);
  float edgeDrift = sin(aUv0.y * 8.0 + uTime * 0.18 + uPhase) * abs(centredX);
  p.z += lens + breathing * (0.025 + loose * 0.085);
  p.x += edgeDrift * loose * 0.035;
  p.y += sin(aUv0.x * 5.2 + uTime * 0.09 + uPhase) * loose * 0.045;
  vUv = aUv0;
  vCurve = lens;
  gl_Position = matrix_viewProjection * matrix_model * vec4(p, 1.0);
}
`;

const VEIL_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform sampler2D uSource;
uniform vec3 uAccent;
uniform vec3 uIvory;
uniform float uTime;
uniform float uResolve;
uniform float uPhase;
uniform float uAvailable;
varying vec2 vUv;
varying float vCurve;

void main(void) {
  float topWave = sin(vUv.x * 12.7 + uPhase) * 0.026 +
    sin(vUv.x * 29.3 - uPhase * 0.7) * 0.011;
  float bottomWave = sin(vUv.x * 10.1 - uPhase * 0.8) * 0.03 +
    sin(vUv.x * 25.7 + uPhase) * 0.013;
  float side = min(vUv.x, 1.0 - vUv.x);
  float top = 1.0 - vUv.y;
  float bottom = vUv.y;
  float sideFeather = smoothstep(0.0, 0.075, side + sin(vUv.y * 17.0 + uPhase) * 0.016);
  float raggedTop = smoothstep(0.0, 0.095, top + topWave);
  float raggedBottom = smoothstep(0.0, 0.10, bottom + bottomWave);
  float perimeter = sideFeather * raggedTop * raggedBottom;

  float loose = 1.0 - uResolve;
  vec2 sourceUv = vec2(vUv.x, 1.0 - vUv.y);
  float separation = loose * (0.003 + abs(vUv.x - 0.5) * 0.006);
  vec3 photograph;
  photograph.r = texture2D(uSource, sourceUv + vec2(separation, 0.0)).r;
  photograph.g = texture2D(uSource, sourceUv).g;
  photograph.b = texture2D(uSource, sourceUv - vec2(separation, 0.0)).b;
  vec3 diffusion = (
    texture2D(uSource, sourceUv + vec2(0.0, 0.005)).rgb +
    texture2D(uSource, sourceUv - vec2(0.0, 0.005)).rgb
  ) * 0.5;
  photograph = mix(photograph, diffusion, loose * 0.18);
  float luminance = dot(photograph, vec3(0.2126, 0.7152, 0.0722));
  vec3 unresolved = mix(uAccent * 0.38, uIvory * 0.74, 0.28 + luminance * 0.48);
  vec3 colour = mix(unresolved, photograph, uAvailable * (0.82 + uResolve * 0.18));

  float glassLight = pow(smoothstep(0.0, 0.34, vCurve), 5.0);
  float fineGrain = sin((vUv.x * 0.7 + vUv.y) * 860.0 + uPhase) * 0.5 + 0.5;
  colour += uIvory * glassLight * (0.025 + loose * 0.035);
  colour *= 0.975 + fineGrain * 0.025;
  colour = mix(colour, mix(uAccent, uIvory, 0.34), (1.0 - uAvailable) * 0.72);

  vec2 absencePoint = (vUv - 0.5) * vec2(1.0, 0.78);
  float absenceRadius = length(absencePoint);
  float absenceRim = smoothstep(0.19, 0.3, absenceRadius) *
    (1.0 - smoothstep(0.39, 0.53, absenceRadius));
  float absenceAngle = atan(absencePoint.y, absencePoint.x);
  float interrupted = smoothstep(-0.34, 0.28,
    sin(absenceAngle * 7.0 + uPhase) + sin(absenceRadius * 42.0 - uTime * 0.12) * 0.32);
  float openSides = smoothstep(0.075, 0.2, abs(absencePoint.x)) *
    (1.0 - smoothstep(0.31, 0.49, abs(absencePoint.y)));
  float evidenceStructure = mix(
    1.0,
    absenceRim * openSides * (0.78 + interrupted * 0.22),
    1.0 - uAvailable
  );
  float breathing = 0.965 + 0.035 * sin(uTime * 0.31 + vUv.x * 4.0 + uPhase);
  float alpha = perimeter * evidenceStructure * breathing;
  alpha *= mix(0.82, 0.98, uResolve) * mix(0.78, 1.0, uAvailable);
  if (alpha < 0.025) discard;
  gl_FragColor = vec4(colour * 1.025, alpha);
}
`;

export interface SourceFirstGrove {
  readonly entity: pc.Entity;
  setTheme(theme: PresentationTheme): void;
  setProfile(profile: WorldArtProfile): void;
  setReducedMotion(reduced: boolean): void;
  setResidency(stages: ReadonlyMap<IslandId, ResidencyStage>, map: boolean): void;
  update(
    nowMs: number,
    cameraPosition: Readonly<{ x: number; y: number; z: number }>,
    focusedIslandId: IslandId | null,
  ): void;
  destroy(): void;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function createVeilMesh(device: pc.GraphicsDevice, columns = 28, rows = 22): pc.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      positions.push((u - 0.5) * VEIL_WIDTH, (v - 0.5) * VEIL_HEIGHT, 0);
      uvs.push(u, v);
    }
  }
  const stride = columns + 1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * stride + column;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new pc.Geometry();
  geometry.positions = positions;
  geometry.uvs = uvs;
  geometry.indices = indices;
  return pc.Mesh.fromGeometry(device, geometry);
}

function createFallbackTexture(device: pc.GraphicsDevice): pc.Texture {
  const texture = new pc.Texture(device, {
    name: 'atlas-source-unavailable',
    width: 1,
    height: 1,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
  });
  const pixels = texture.lock() as Uint8Array;
  pixels.set([72, 63, 104, 255]);
  texture.unlock();
  return texture;
}

function createSourceTexture(device: pc.GraphicsDevice, url: string): pc.Texture {
  const texture = new pc.Texture(device, {
    name: `atlas-source:${url}`,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => texture.setSource(image);
  image.src = url;
  return texture;
}

function createVeilMaterial(
  texture: pc.Texture,
  accent: string,
  ivory: string,
  available: boolean,
  phase: number,
): pc.ShaderMaterial {
  const material = new pc.ShaderMaterial({
    uniqueName: `orimera-memory-veil:${phase}`,
    attributes: { aPosition: pc.SEMANTIC_POSITION, aUv0: pc.SEMANTIC_TEXCOORD0 },
    vertexGLSL: VEIL_VERTEX_GLSL,
    fragmentGLSL: VEIL_FRAGMENT_GLSL,
  } as ShaderDesc);
  material.setParameter('uSource', texture);
  material.setParameter('uAccent', new Float32Array(unitRgb(accent)));
  material.setParameter('uIvory', new Float32Array(unitRgb(ivory)));
  material.setParameter('uTime', 0);
  material.setParameter('uResolve', 0.42);
  material.setParameter('uPhase', phase);
  material.setParameter('uAvailable', available ? 1 : 0);
  material.cull = pc.CULLFACE_NONE;
  material.blendType = pc.BLEND_NORMAL;
  material.depthWrite = true;
  material.update();
  return material;
}

function createAtmosphereMaterial(
  vertexGLSL: string,
  fragmentGLSL: string,
  uniqueName: string,
  accent: string,
  ivory: string,
  phase: number,
  texture?: pc.Texture,
  available = true,
): pc.ShaderMaterial {
  const material = new pc.ShaderMaterial({
    uniqueName,
    attributes: { aPosition: pc.SEMANTIC_POSITION, aUv0: pc.SEMANTIC_TEXCOORD0 },
    vertexGLSL,
    fragmentGLSL,
  } as ShaderDesc);
  if (texture !== undefined) material.setParameter('uSource', texture);
  material.setParameter('uAccent', new Float32Array(unitRgb(accent)));
  material.setParameter('uIvory', new Float32Array(unitRgb(ivory)));
  material.setParameter('uTime', 0);
  material.setParameter('uPhase', phase);
  material.setParameter('uAvailable', available ? 1 : 0);
  material.cull = pc.CULLFACE_NONE;
  material.blendType = pc.BLEND_NORMAL;
  material.depthWrite = false;
  material.update();
  return material;
}

/**
 * Rung-4 memories appear as source-bearing veils. The photograph is not pinned to a card or built
 * into scenery: it is woven into an optical sheet whose threads settle as attention approaches.
 */
export function createSourceFirstGrove(
  app: pc.AppBase,
  scene: AtlasScene,
  sourceMedia: SourceMediaCatalog,
  initialProfile: WorldArtProfile = ORIGIN_LANDSCAPE,
  _theme: PresentationTheme = DAWN_THEME,
  initiallyReducedMotion = false,
): SourceFirstGrove {
  const device = app.graphicsDevice;
  const root = new pc.Entity('source-first-grove');
  const veilMesh = createVeilMesh(device);
  const fallbackTexture = createFallbackTexture(device);
  const textures: pc.Texture[] = [fallbackTexture];
  const assets: pc.Asset[] = [];
  const memories: MemoryVisual[] = [];

  for (const island of scene.islands) {
    if (island.rung !== 4) continue;
    const media = sourceMediaForIsland(island, sourceMedia);
    const available = media.find((item) => item.available && item.url !== null);
    const accent = available?.accent ?? media[0]?.accent ?? initialProfile.palette.stoneShadow;
    const phase = island.creationOrdinal * 1.73 + 0.4;
    const texture = available?.url === null || available === undefined
      ? fallbackTexture
      : createSourceTexture(device, available.url);
    if (texture !== fallbackTexture) textures.push(texture);

    const group = new pc.Entity(`memory:${island.islandId}`);
    group.setPosition(island.placement.position.x, island.placement.position.y, island.placement.position.z);
    group.setEulerAngles(0, (island.placement.yaw * 180) / Math.PI, 0);
    group.setLocalScale(island.placement.scale, island.placement.scale, island.placement.scale);

    const local = sourceFirstCardLocalPosition(island);
    const baseWorld = localToAtlas(island.placement, local);
    const veil = new pc.Entity(`memory-veil:${island.islandId}`);
    const surfaceY = atlasLandscapeHeight(baseWorld.x, baseWorld.z) - island.placement.position.y;
    const veilY = surfaceY + SOURCE_VEIL_HEIGHT;
    veil.setLocalPosition(local.x, veilY, local.z);
    const material = createVeilMaterial(
      texture,
      accent,
      initialProfile.palette.paper,
      available !== undefined,
      phase,
    );
    const veilInstance = new pc.MeshInstance(veilMesh, material, veil);
    veilInstance.castShadow = false;
    veilInstance.receiveShadow = false;
    veil.addComponent('render', { meshInstances: [veilInstance] });
    group.addChild(veil);

    const auraMaterial = createAtmosphereMaterial(
      AURA_VERTEX_GLSL,
      AURA_FRAGMENT_GLSL,
      `orimera-memory-atmosphere:${phase}`,
      accent,
      initialProfile.palette.paper,
      phase,
      texture,
      available !== undefined,
    );
    const aura = new pc.Entity(`memory-atmosphere:${island.islandId}`);
    aura.setLocalPosition(local.x, veilY, local.z - 0.52);
    aura.setLocalScale(1.95, 1.72, 1);
    aura.addComponent('render', { meshInstances: [new pc.MeshInstance(veilMesh, auraMaterial, aura)] });
    group.addChild(aura);

    if (available?.url !== null && available !== undefined) {
      const asset = new pc.Asset(`atlas-source:${available.evidenceRef}`, 'texture', { url: available.url });
      asset.ready((ready) => {
        const loaded = ready.resource as pc.Texture | null;
        if (loaded !== null) material.setParameter('uSource', loaded);
      });
      app.assets.add(asset);
      app.assets.load(asset);
      assets.push(asset);
    }

    root.addChild(group);
    memories.push({
      islandId: island.islandId,
      group,
      veil,
      material,
      auraMaterial,
      baseWorld,
      phase,
      unavailable: available === undefined,
      profileScale: 1,
      resolve: 0.42,
      lastNowMs: 0,
    });
  }

  let idleCycleMs = initialProfile.ui.motion.idleCycleMs;
  let reducedMotion = initiallyReducedMotion;
  const setProfile = (profile: WorldArtProfile): void => {
    idleCycleMs = profile.ui.motion.idleCycleMs;
    for (const memory of memories) {
      memory.material.setParameter('uIvory', new Float32Array(unitRgb(profile.palette.paper)));
      memory.auraMaterial.setParameter('uIvory', new Float32Array(unitRgb(profile.palette.paper)));
      const detail = Math.max(0.85, Math.min(1.12, 0.86 + profile.geometry.detailCount * 0.025));
      memory.profileScale = detail;
    }
  };
  setProfile(initialProfile);

  return {
    entity: root,
    setTheme() {},
    setProfile,
    setReducedMotion(reduced) {
      reducedMotion = reduced;
    },
    setResidency(stages, map) {
      for (const memory of memories) {
        memory.group.enabled = !map && (stages.get(memory.islandId) ?? 'stub') !== 'stub';
      }
    },
    update(nowMs, cameraPosition, focusedIslandId) {
      const seconds = worldMotionSeconds(nowMs, idleCycleMs, reducedMotion);
      for (const memory of memories) {
        const dx = cameraPosition.x - memory.baseWorld.x;
        const dz = cameraPosition.z - memory.baseWorld.z;
        const distance = Math.hypot(dx, dz);
        const approach = 1 - smoothstep(4.2, 15.0, distance);
        const target = focusedIslandId === memory.islandId
          ? 1
          : (memory.unavailable ? 0.2 + approach * 0.34 : 0.42 + approach * 0.58);
        if (memory.lastNowMs === 0) {
          memory.resolve = target;
        } else {
          const frameSeconds = Math.min(0.05, Math.max(0, nowMs - memory.lastNowMs) * 0.001);
          memory.resolve += (target - memory.resolve) * (1 - Math.exp(-frameSeconds * 3.8));
        }
        memory.lastNowMs = nowMs;
        memory.material.setParameter('uTime', seconds);
        memory.material.setParameter('uResolve', memory.resolve);
        memory.auraMaterial.setParameter('uTime', seconds);
        // Direct travel can legally resolve very near a source. Keep the veil room-scale without
        // letting it swallow the entire camera when the protected destination is close.
        const proximityScale = memory.unavailable
          ? Math.max(0.30, Math.min(0.58, distance / 10))
          : 0.68 + smoothstep(3.5, 10.5, distance) * 0.32;
        const displayScale = memory.profileScale * proximityScale;
        memory.veil.setLocalScale(displayScale, displayScale, displayScale);
      }
    },
    destroy() {
      veilMesh.destroy();
      for (const memory of memories) {
        memory.material.destroy();
        memory.auraMaterial.destroy();
      }
      for (const texture of textures) texture.destroy();
      for (const asset of assets) {
        asset.unload();
        app.assets.remove(asset);
      }
    },
  };
}

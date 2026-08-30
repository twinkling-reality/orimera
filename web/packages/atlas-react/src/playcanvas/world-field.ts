import * as pc from 'playcanvas';
import type { NavigationPose, NavigationWorld } from '@orimera/atlas-core';
import {
  DAWN_THEME,
  ORIGIN_LANDSCAPE,
  unitRgb,
  type PresentationTheme,
  type WorldArtProfile,
} from '@orimera/presentation';

const MAX_REGIONS = 5;
const MAX_TRACES = 10;

interface ShaderDesc {
  uniqueName: string;
  attributes?: Record<string, string>;
  vertexGLSL?: string;
  fragmentGLSL?: string;
}

const VERTEX_GLSL = /* glsl */ `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 matrix_model;
uniform mat3 matrix_normal;
uniform mat4 matrix_viewProjection;
varying vec3 vWorld;
varying vec3 vNormal;

void main(void) {
    vec4 world = matrix_model * vec4(aPosition, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(matrix_normal * aNormal);
    gl_Position = matrix_viewProjection * world;
}
`;

const FRAGMENT_GLSL = /* glsl */ `
precision highp float;

varying vec3 vWorld;
varying vec3 vNormal;
uniform vec3 view_position;
uniform vec3 uGround;
uniform vec3 uSurface;
uniform vec3 uAtmosphere;
uniform vec3 uTraceColour;
uniform vec4 uField;
uniform vec4 uRegions[${MAX_REGIONS}];
uniform vec4 uTraceA[${MAX_TRACES}];
uniform vec4 uTraceB[${MAX_TRACES}];
uniform vec2 uCounts;
uniform float uMapMode;

float segmentDistance(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
    return length(p - (a + ab * t));
}

void main(void) {
    vec2 p = vWorld.xz;
    vec2 local = p - uField.xy;
    float directional = 0.5 + 0.5 * dot(normalize(local + vec2(0.01)), normalize(vec2(0.47, -0.88)));
    float longWave = 0.5 + 0.5 * sin(p.x * 0.018 + p.y * 0.011);
    float mineral = sin(p.x * 0.31 + sin(p.y * 0.17) * 0.8) *
                    cos(p.y * 0.23 - sin(p.x * 0.13) * 0.65);
    float contour = 0.5 + 0.5 * sin(length(local) * 0.62 + mineral * 0.8);
    vec3 colour = mix(uGround, uAtmosphere, 0.025 + 0.035 * directional + 0.018 * longWave);
    float grain = 0.93 + mineral * 0.04 + smoothstep(0.86, 1.0, contour) * 0.035;
    colour *= mix(grain, 0.98, uMapMode);
    float rakedLight = max(0.0, dot(normalize(vNormal), normalize(vec3(-0.55, 0.68, 0.48))));
    colour *= mix(0.74 + rakedLight * 0.5, 1.0, uMapMode);
    // Map is a distinct cartographic reading of the same world, not a flattened screenshot.
    // Lift the field toward the atmospheric glass color so relationship ink remains legible.
    colour = mix(colour, mix(uGround, uAtmosphere, 0.7), uMapMode * 0.58);

    for (int i = 0; i < ${MAX_REGIONS}; i++) {
        if (float(i) >= uCounts.x) break;
        vec4 region = uRegions[i];
        vec2 delta = p - region.xy;
        float warp = sin(delta.x * 0.22 + float(i)) * 0.42 + cos(delta.y * 0.17) * 0.34;
        float d = length(delta) + warp;
        float approach = 1.0 - smoothstep(region.z, region.z + 24.0, d);
        float core = 1.0 - smoothstep(region.w, region.z, d);
        colour = mix(colour, uSurface, 0.13 * approach + 0.22 * core + uMapMode * (0.14 * approach + 0.2 * core));
        float seam = smoothstep(region.w - 0.9, region.w + 0.2, d) *
                     (1.0 - smoothstep(region.z - 0.15, region.z + 1.15, d));
        colour *= 1.0 - 0.045 * seam;
        float mapRing = 1.0 - smoothstep(0.0, 0.34, abs(d - 4.4));
        float mapNode = 1.0 - smoothstep(0.65, 1.7, d);
        colour = mix(colour, uTraceColour, mapRing * uMapMode * 0.72);
        colour = mix(colour, uTraceColour, mapNode * uMapMode * 0.96);
    }

    for (int i = 0; i < ${MAX_TRACES}; i++) {
        if (float(i) >= uCounts.y) break;
        float d = segmentDistance(p, uTraceA[i].xy, uTraceB[i].xy);
        float trace = 1.0 - smoothstep(0.12, 0.34 + uTraceA[i].z * 0.28, d);
        colour = mix(colour, uTraceColour, trace * (0.06 + uTraceA[i].z * 0.1 + uMapMode * 0.82));
    }

    float radial = length(local);
    float edge = smoothstep(uField.z, uField.w, radial);
    colour = mix(colour, uAtmosphere, edge * 0.76 * (1.0 - uMapMode));
    float distanceFog = smoothstep(72.0, 260.0, distance(vWorld, view_position)) * (1.0 - uMapMode);
    colour = mix(colour, uAtmosphere, distanceFog * 0.88);
    gl_FragColor = vec4(colour, 1.0);
}
`;

export interface WorldField {
  readonly entity: pc.Entity;
  setTheme(theme: PresentationTheme): void;
  setProfile(profile: WorldArtProfile): void;
  setMapGroundPose(pose: NavigationPose | null): void;
  destroy(): void;
}

function createLandscapeMesh(
  device: pc.GraphicsDevice,
  world: NavigationWorld,
  halfExtent: number,
  segments = 160,
): pc.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let zIndex = 0; zIndex <= segments; zIndex += 1) {
    const localZ = -halfExtent + (zIndex / segments) * halfExtent * 2;
    for (let xIndex = 0; xIndex <= segments; xIndex += 1) {
      const localX = -halfExtent + (xIndex / segments) * halfExtent * 2;
      const sample = world.surface.sample(world.centre.x + localX, world.centre.z + localZ);
      const height = sample?.height ?? 0;
      const normal = sample?.normal ?? { x: 0, y: 1, z: 0 };
      positions.push(localX, height, localZ);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  const stride = segments + 1;
  for (let zIndex = 0; zIndex < segments; zIndex += 1) {
    for (let xIndex = 0; xIndex < segments; xIndex += 1) {
      const a = zIndex * stride + xIndex;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new pc.Geometry();
  geometry.positions = positions;
  geometry.normals = normals;
  geometry.indices = indices;
  return pc.Mesh.fromGeometry(device, geometry);
}

/** A continuous low-frequency field: ground, soft region bodies, and confirmed semantic traces. */
export function createWorldField(
  device: pc.GraphicsDevice,
  world: NavigationWorld,
  initialProfile: WorldArtProfile = ORIGIN_LANDSCAPE,
  theme: PresentationTheme = DAWN_THEME,
): WorldField {
  const entity = new pc.Entity('atlas-world-field');
  // The navigable/recovery radii remain visible in the material, but the physical draw surface
  // extends beyond the far clip so its square edge can never masquerade as a platform boundary.
  const visualHalfExtent = Math.max(420, world.recoveryRadius * 2.6);
  const mesh = createLandscapeMesh(device, world, visualHalfExtent);
  const material = new pc.ShaderMaterial({
    uniqueName: 'orimera-grounded-world-field',
    attributes: { aPosition: pc.SEMANTIC_POSITION, aNormal: pc.SEMANTIC_NORMAL },
    vertexGLSL: VERTEX_GLSL,
    fragmentGLSL: FRAGMENT_GLSL,
  } as ShaderDesc);
  material.cull = pc.CULLFACE_NONE;
  material.depthWrite = true;
  material.blendType = pc.BLEND_NONE;

  const regions = new Float32Array(MAX_REGIONS * 4);
  for (let i = 0; i < Math.min(MAX_REGIONS, world.regions.length); i += 1) {
    const region = world.regions[i]!;
    regions.set(
      [region.centre.x, region.centre.z, region.footprintRadius, region.dissolveStartRadius],
      i * 4,
    );
  }
  const traceA = new Float32Array(MAX_TRACES * 4);
  const traceB = new Float32Array(MAX_TRACES * 4);
  for (let i = 0; i < Math.min(MAX_TRACES, world.traces.length); i += 1) {
    const trace = world.traces[i]!;
    traceA.set([trace.start.x, trace.start.z, trace.strength, 0], i * 4);
    traceB.set([trace.end.x, trace.end.z, 0, 0], i * 4);
  }
  material.setParameter('uField', new Float32Array([
    world.centre.x,
    world.centre.z,
    world.fieldRadius,
    world.recoveryRadius,
  ]));
  material.setParameter('uRegions[0]', regions);
  material.setParameter('uTraceA[0]', traceA);
  material.setParameter('uTraceB[0]', traceB);
  material.setParameter('uCounts', new Float32Array([
    Math.min(MAX_REGIONS, world.regions.length),
    Math.min(MAX_TRACES, world.traces.length),
  ]));
  material.setParameter('uMapMode', 0);

  const setProfile = (profile: WorldArtProfile): void => {
    material.setParameter('uGround', new Float32Array(unitRgb(profile.palette.terrain)));
    material.setParameter('uSurface', new Float32Array(unitRgb(profile.palette.terrainLift)));
    material.setParameter('uAtmosphere', new Float32Array(unitRgb(profile.palette.haze)));
    material.setParameter('uTraceColour', new Float32Array(unitRgb(profile.palette.path)));
    material.update();
  };
  setProfile(initialProfile);

  entity.setPosition(world.centre.x, -0.035, world.centre.z);
  entity.addComponent('render', {
    meshInstances: [new pc.MeshInstance(mesh, material, entity)],
  });

  const marker = new pc.Entity('atlas-map-user-marker');
  const markerGeometry = new pc.Geometry();
  markerGeometry.positions = [0, 0, -4.2, -2.1, 0, 0.8, 2.1, 0, 0.8];
  markerGeometry.indices = [0, 1, 2];
  const markerMesh = pc.Mesh.fromGeometry(device, markerGeometry);
  const markerMaterial = new pc.StandardMaterial();
  markerMaterial.useLighting = false;
  markerMaterial.cull = pc.CULLFACE_NONE;
  markerMaterial.emissiveIntensity = 1;
  markerMaterial.opacity = 0.24;
  markerMaterial.blendType = pc.BLEND_NORMAL;
  markerMaterial.depthWrite = false;

  const body = new pc.Entity('atlas-map-user-body');
  const bodyGeometry = new pc.Geometry();
  bodyGeometry.positions = [0, 0, -0.9, -0.48, 0, 0.55, 0.48, 0, 0.55];
  bodyGeometry.indices = [0, 1, 2];
  const bodyMesh = pc.Mesh.fromGeometry(device, bodyGeometry);
  const bodyMaterial = new pc.StandardMaterial();
  bodyMaterial.useLighting = false;
  bodyMaterial.cull = pc.CULLFACE_NONE;
  bodyMaterial.emissiveIntensity = 1;
  body.addComponent('render', {
    meshInstances: [new pc.MeshInstance(bodyMesh, bodyMaterial, body)],
  });
  body.setLocalPosition(0, 0.02, 0);
  marker.addChild(body);
  const setMarkerTheme = (next: PresentationTheme): void => {
    const [r, g, b] = unitRgb(next.focus);
    markerMaterial.diffuse.set(r, g, b);
    markerMaterial.emissive.set(r, g, b);
    bodyMaterial.diffuse.set(r, g, b);
    bodyMaterial.emissive.set(r, g, b);
    markerMaterial.update();
    bodyMaterial.update();
  };
  setMarkerTheme(theme);
  marker.addComponent('render', {
    meshInstances: [new pc.MeshInstance(markerMesh, markerMaterial, marker)],
  });
  marker.enabled = false;
  entity.addChild(marker);

  return {
    entity,
    setTheme(next) {
      setMarkerTheme(next);
    },
    setProfile,
    setMapGroundPose(pose) {
      marker.enabled = pose !== null;
      material.setParameter('uMapMode', pose === null ? 0 : 1);
      if (pose === null) return;
      marker.setPosition(pose.position.x - world.centre.x, 0.09, pose.position.z - world.centre.z);
      marker.setEulerAngles(0, (pose.yaw * 180) / Math.PI, 0);
    },
    destroy() {
      markerMesh.destroy();
      bodyMesh.destroy();
      mesh.destroy();
      material.destroy();
      markerMaterial.destroy();
      bodyMaterial.destroy();
    },
  };
}

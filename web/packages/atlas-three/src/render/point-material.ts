import {
  ClampToEdgeWrapping,
  DataTexture,
  GLSL3,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import { DISSOLVE_BAND_FRACTION } from '@orimera/atlas-core';
import { SEGMENT_TABLE_WIDTH } from '../semantic-state.js';
import { POINT_FRAGMENT_SHADER, POINT_VERTEX_SHADER } from './point-shader.js';

/**
 * The material wrapper. One instance per island, because the state texture, the footprint radius
 * and the capture viewpoint are per island; everything else is shared per frame by the renderer.
 *
 * `transparent: false`, `depthWrite: true`, `blending: NoBlending`. Every soft edge in this
 * binding is produced by stochastic discard, so there is no transparent pass, no per-frame sort
 * and no draw-order dependency between islands. That is the property that makes N islands in one
 * canvas cost N draw calls rather than N sorted overlapping clouds.
 */

export interface PointMaterialParams {
  /** Vertical field of view of the CAPTURE camera, degrees, from the .opm header. */
  readonly captureFovYDeg: number;
  readonly sourceImageHeight: number;
  readonly viewpointLocal: readonly [number, number, number];
  readonly footprintRadiusLocal: number;
  readonly islandScale: number;
}

export interface PointFrameUniforms {
  readonly viewportHeightPx: number;
  /** tan(fovY/2) of the VIEWING camera, which the comfort settings may change at runtime. */
  readonly tanHalfFov: number;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly fogColor: Vector3;
  readonly timeSeconds: number;
  /** 0 under `prefers-reduced-motion`. Kills the ambient unresolved pulse, keeps every label. */
  readonly motion: number;
}

export interface PointAppearanceSettings {
  /** >1 overlaps neighbouring points. 1.0 is the honest sampling rate and shows pinholes. */
  coverage: number;
  pointSizeClampPx: readonly [number, number];
  /** A zero-confidence point is faint, never invisible: deleting it would hide the honest hole. */
  confidenceFloor: number;
  /** Spatial scatter of unconfirmed points, in multiples of their own patch size. */
  unconfirmedScatter: number;
  /** e-folding decay beyond the footprint, in footprint radii. Larger is a longer, wispier tail. */
  boundaryFalloff: number;
  ditherFloor: number;
  /** People render as presence markers, not geometry. Off only to measure the cost of the rule. */
  suppressPeople: boolean;
}

export const DEFAULT_APPEARANCE: PointAppearanceSettings = {
  coverage: 1.9,
  pointSizeClampPx: [1, 26],
  confidenceFloor: 0.12,
  unconfirmedScatter: 2.4,
  boundaryFalloff: 0.35,
  ditherFloor: 0,
  suppressPeople: true,
};

export class PointMaterial {
  readonly material: ShaderMaterial;
  readonly stateTexture: DataTexture;

  constructor(params: PointMaterialParams, stateData: Uint8Array) {
    this.stateTexture = new DataTexture(
      stateData,
      SEGMENT_TABLE_WIDTH,
      1,
      RGBAFormat,
      UnsignedByteType,
    );
    // Nearest, no mips, clamped. This is a lookup table, not an image; any filtering would blend
    // one segment's epistemic state into its neighbour's, which is exactly the class of quiet
    // error the four provenance classes exist to prevent.
    this.stateTexture.magFilter = NearestFilter;
    this.stateTexture.minFilter = NearestFilter;
    this.stateTexture.wrapS = ClampToEdgeWrapping;
    this.stateTexture.wrapT = ClampToEdgeWrapping;
    this.stateTexture.generateMipmaps = false;
    this.stateTexture.needsUpdate = true;

    const pixelAngle =
      (2 * Math.tan((params.captureFovYDeg * Math.PI) / 360)) / params.sourceImageHeight;

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: POINT_VERTEX_SHADER,
      fragmentShader: POINT_FRAGMENT_SHADER,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      blending: NoBlending,
      uniforms: {
        uSegmentState: { value: this.stateTexture },
        uViewpointLocal: {
          value: new Vector3(
            params.viewpointLocal[0],
            params.viewpointLocal[1],
            params.viewpointLocal[2],
          ),
        },
        uPixelAngle: { value: pixelAngle },
        uIslandScale: { value: params.islandScale },
        uViewportHeightPx: { value: 1080 },
        uTanHalfFov: { value: Math.tan((70 * Math.PI) / 360) },
        uCoverage: { value: DEFAULT_APPEARANCE.coverage },
        uPointSizeClampPx: {
          value: new Vector2(
            DEFAULT_APPEARANCE.pointSizeClampPx[0],
            DEFAULT_APPEARANCE.pointSizeClampPx[1],
          ),
        },
        uFootprintRadius: { value: params.footprintRadiusLocal },
        uDissolveBand: { value: DISSOLVE_BAND_FRACTION },
        uBoundaryFalloff: { value: DEFAULT_APPEARANCE.boundaryFalloff },
        uFogNear: { value: 30 },
        uFogFar: { value: 420 },
        uFogColor: { value: new Vector3(0.043, 0.051, 0.071) },
        uIslandEmphasis: { value: 1 },
        uConfidenceFloor: { value: DEFAULT_APPEARANCE.confidenceFloor },
        uUnconfirmedScatter: { value: DEFAULT_APPEARANCE.unconfirmedScatter },
        uTime: { value: 0 },
        uMotion: { value: 1 },
        uSuppressPeople: { value: 1 },
        uDitherFloor: { value: DEFAULT_APPEARANCE.ditherFloor },
      },
    });
  }

  /** Called once per frame per island. Six scalar writes; no allocation, no shader recompile. */
  setFrame(frame: PointFrameUniforms, islandEmphasis: number): void {
    const u = this.material.uniforms;
    u.uViewportHeightPx!.value = frame.viewportHeightPx;
    u.uTanHalfFov!.value = frame.tanHalfFov;
    u.uFogNear!.value = frame.fogNear;
    u.uFogFar!.value = frame.fogFar;
    (u.uFogColor!.value as Vector3).copy(frame.fogColor);
    u.uTime!.value = frame.timeSeconds;
    u.uMotion!.value = frame.motion;
    u.uIslandEmphasis!.value = islandEmphasis;
  }

  applyAppearance(a: PointAppearanceSettings): void {
    const u = this.material.uniforms;
    u.uCoverage!.value = a.coverage;
    (u.uPointSizeClampPx!.value as Vector2).set(a.pointSizeClampPx[0], a.pointSizeClampPx[1]);
    u.uConfidenceFloor!.value = a.confidenceFloor;
    u.uUnconfirmedScatter!.value = a.unconfirmedScatter;
    u.uBoundaryFalloff!.value = a.boundaryFalloff;
    u.uDitherFloor!.value = a.ditherFloor;
    u.uSuppressPeople!.value = a.suppressPeople ? 1 : 0;
  }

  /** One texture upload of 1 KB. The whole cost of a recomposition for a 4M-point island. */
  flagStateDirty(): void {
    this.stateTexture.needsUpdate = true;
  }

  dispose(): void {
    this.material.dispose();
    this.stateTexture.dispose();
  }
}

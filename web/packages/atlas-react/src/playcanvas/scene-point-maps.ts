import type { IslandId } from '@exulanica/atlas-core';
import type { PointMap } from './opm.js';

/** One verified OPM artifact placed into a shared reconstruction-scene frame. */
export interface PlacedScenePointMap {
  readonly sceneId: string;
  readonly artifactId: string;
  readonly islandId: IslandId;
  readonly map: PointMap;
  readonly sceneFromOpmRowMajor: readonly number[];
  readonly localUnitsToSceneUnits: number;
}

/** Refuse matrices whose producer-side affine and finite guarantees were lost on the wire. */
export function validateScenePointMapPlacement(value: PlacedScenePointMap): void {
  const matrix = value.sceneFromOpmRowMajor;
  if (matrix.length !== 16 || matrix.some((component) => !Number.isFinite(component))) {
    throw new TypeError('scene point-map placement must be a finite 4x4 matrix');
  }
  if (matrix[12] !== 0 || matrix[13] !== 0 || matrix[14] !== 0 || matrix[15] !== 1) {
    throw new TypeError('scene point-map placement must be an affine row-major matrix');
  }
  if (!Number.isFinite(value.localUnitsToSceneUnits) || value.localUnitsToSceneUnits <= 0) {
    throw new TypeError('scene point-map scale must be finite and positive');
  }
}

/** Transform one OPM-frame point into its reconstruction scene frame. */
export function opmPointInScene(
  value: PlacedScenePointMap,
  point: readonly [number, number, number],
): readonly [number, number, number] {
  validateScenePointMapPlacement(value);
  const matrix = value.sceneFromOpmRowMajor;
  const scale = value.localUnitsToSceneUnits;
  const x = point[0] * scale;
  const y = point[1] * scale;
  const z = point[2] * scale;
  return [
    matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
    matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
    matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!,
  ];
}

/** Ground-plane radius containing every transformed OPM bound in one scene. */
export function scenePointMapFootprint(values: readonly PlacedScenePointMap[]): number {
  let radius = 0;
  for (const value of values) {
    const { min, max } = value.map.header.bounds;
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) {
        for (const z of [min[2], max[2]]) {
          const placed = opmPointInScene(value, [x, y, z]);
          radius = Math.max(radius, Math.hypot(placed[0], placed[2]));
        }
      }
    }
  }
  return radius;
}

/** The first recovered camera, transformed into the scene frame for source-first arrival. */
export function scenePointMapViewpoint(
  value: PlacedScenePointMap,
): readonly [number, number, number] {
  return opmPointInScene(value, value.map.header.viewpoint.position);
}

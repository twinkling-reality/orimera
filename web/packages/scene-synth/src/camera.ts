/**
 * A real pinhole camera, because the spatial distribution of a point map is a consequence of
 * perspective and nothing else.
 *
 * This is the single most important property of the generator for the ADR-0003 bake-off. A real
 * MoGe point map has ONE POINT PER VALID PIXEL, so world-space point density falls off as 1/z^2:
 * near surfaces are dense, far surfaces are sparse, and both live in the same buffer. Uniform
 * noise in a box has none of that, and a renderer's sort cost, overdraw and LoD behaviour all
 * depend on it. A bake-off run against uniform noise measures nothing.
 *
 * Convention: right handed, +Y up, camera looks along -Z. Both candidate engines in ADR-0003 use
 * that convention, so neither has to flip anything at load time.
 */

export interface Intrinsics {
  readonly width: number;
  readonly height: number;
  readonly fovYDeg: number;
  /** Focal length in pixels. Square pixels, so fx === fy. */
  readonly focal: number;
  readonly cx: number;
  readonly cy: number;
}

export function intrinsics(width: number, height: number, fovYDeg: number): Intrinsics {
  const focal = height / 2 / Math.tan((fovYDeg * Math.PI) / 360);
  return { width, height, fovYDeg, focal, cx: width / 2, cy: height / 2 };
}

/**
 * The ray direction for a pixel, NOT normalised: its z component is exactly -1, so the ray
 * parameter t equals perpendicular depth. That keeps the depth buffer a real depth buffer rather
 * than a distance buffer, which is what a monocular depth model actually predicts.
 */
export function pixelRay(
  k: Intrinsics,
  px: number,
  py: number,
): { readonly dx: number; readonly dy: number } {
  return {
    dx: (px + 0.5 - k.cx) / k.focal,
    dy: (k.cy - (py + 0.5)) / k.focal,
  };
}

/** Choose an image size for a target point count, given an observed valid-pixel fraction. */
export function resolutionFor(
  targetPoints: number,
  validFraction: number,
  aspect: number,
): { width: number; height: number } {
  const pixels = targetPoints / Math.max(1e-6, validFraction);
  const height = Math.max(8, Math.round(Math.sqrt(pixels / aspect)));
  return { width: Math.max(8, Math.round(height * aspect)), height };
}

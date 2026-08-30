import * as pc from 'playcanvas';
import { DISSOLVE_BAND_FRACTION } from '@orimera/atlas-core';
import {
  BLUE_HOUR_THEME,
  pointProvenancePalette,
  unitRgb,
  type PresentationTheme,
} from '@orimera/presentation';
import type { PointMap } from './opm.js';
import { footprintRadiusOf, packedVertexBytes } from './opm.js';
import type { SegmentSemantics } from './semantics.js';
import { MAX_SEGMENTS, packSemantics } from './semantics.js';
import {
  POINT_FRAGMENT_GLSL,
  POINT_FRAGMENT_WGSL,
  POINT_VERTEX_GLSL,
  POINT_VERTEX_WGSL,
} from './point-shader.js';

/**
 * One island's 2.5D shell as a PlayCanvas mesh.
 *
 * ENGINE CONSTRAINT WORTH RECORDING. A PlayCanvas `Mesh` owns exactly one `VertexBuffer`. There is
 * no equivalent of three.js's independent `BufferAttribute` per channel, and the only second
 * stream a mesh can carry is the hardware-instancing one. So a planar (structure-of-arrays) point
 * map has to arrive as a single contiguous run of position, then colour, then segment, in that
 * order and with no padding between them, or it has to be repacked on the CPU.
 *
 * `.opm` happens to satisfy that for every count in the bake-off ladder, so the fast path is a
 * zero-copy `Uint8Array` view of the fetched file. `packedVertexBytes` reports when it is not
 * satisfied and a copy was made, because a per-point CPU pass inside a render benchmark is
 * exactly the kind of thing that should never be silent.
 */

export interface PointCloudOptions {
  readonly device: pc.GraphicsDevice;
  readonly map: PointMap;
  readonly semantics: readonly SegmentSemantics[];
  /** Screen-space size gain. Multiplied by the projection scale and divided by view distance. */
  readonly sizeGain?: number;
  readonly maxSizePx?: number;
  /** Alpha blending instead of the alpha-tested opaque path. Order-dependent; off by default. */
  readonly blend?: boolean;
  readonly theme?: PresentationTheme;
}

export interface PointCloud {
  readonly mesh: pc.Mesh;
  readonly material: pc.ShaderMaterial;
  readonly vertexBuffer: pc.VertexBuffer;
  readonly pointCount: number;
  readonly footprintRadiusLocal: number;
  /** True when the loader had to repack the file. Reported, never hidden. */
  readonly repacked: boolean;
  readonly vertexBytes: number;
  readonly defaultSizeGain: number;
  readonly defaultMaxSizePx: number;
  setTheme(theme: PresentationTheme): void;
  destroy(): void;
}

/**
 * Default sprite sizing.
 *
 * `sizeGain` is a world-space length: the shader turns it into pixels with the projection scale
 * and the view distance, so a point keeps a constant world footprint rather than a constant screen
 * one. 0.05 m is roughly the sample spacing of the 1M fixture at mid depth, which is the value
 * that makes the shell read as a surface instead of as noise without inventing coverage the
 * capture never had.
 */
const DEFAULT_SIZE_GAIN = 0.05;
const DEFAULT_MAX_SIZE_PX = 10;

const ATTRIBUTES = {
  aPosition: pc.SEMANTIC_POSITION,
  aColor: pc.SEMANTIC_COLOR,
  aSegment: pc.SEMANTIC_ATTR8,
} as const;

/** `ShaderDesc` is documented but not exported from the engine's type surface, so it is restated. */
interface ShaderDesc {
  uniqueName: string;
  attributes?: Record<string, string>;
  vertexGLSL?: string;
  fragmentGLSL?: string;
  vertexWGSL?: string;
  fragmentWGSL?: string;
}

function buildShaderDesc(blend: boolean): ShaderDesc {
  return {
    uniqueName: `orimera-point-map${blend ? '-blend' : ''}`,
    attributes: { ...ATTRIBUTES },
    vertexGLSL: blend ? `#define POINT_BLEND\n${POINT_VERTEX_GLSL}` : POINT_VERTEX_GLSL,
    fragmentGLSL: blend ? `#define POINT_BLEND\n${POINT_FRAGMENT_GLSL}` : POINT_FRAGMENT_GLSL,
    vertexWGSL: POINT_VERTEX_WGSL,
    fragmentWGSL: POINT_FRAGMENT_WGSL,
  };
}

/**
 * Repack the planar buffer with `segment` widened from uint16 to uint16x2.
 *
 * Layout out: position 12N, colour 4N, segment 4N, which is 20 bytes per point against the
 * container's 18. The positions and colours are moved with two `set` calls, so only the segment
 * channel costs a per-point loop.
 */
function padSegmentChannel(map: PointMap): { bytes: Uint8Array; copied: boolean } {
  const n = map.header.pointCount;
  const out = new Uint8Array(20 * n);
  out.set(new Uint8Array(map.position.buffer, map.position.byteOffset, 12 * n), 0);
  out.set(map.color, 12 * n);
  const padded = new Uint16Array(out.buffer, 16 * n, 2 * n);
  const source = map.segment;
  for (let i = 0; i < n; i += 1) padded[i * 2] = source[i]!;
  return { bytes: out, copied: true };
}

export function createPointCloud(options: PointCloudOptions): PointCloud {
  const { device, map, semantics } = options;
  const n = map.header.pointCount;

  /**
   * THE 2-BYTE SEGMENT CHANNEL IS A HARD WEBGPU ERROR, NOT A PERFORMANCE HINT.
   *
   * The `.opm` container stores `segment` as one uint16 per point, which in a planar layout means
   * a vertex stream with `arrayStride` 2. PlayCanvas's own debug build only warns about this
   * ("element size not multiple of 4 can have performance impact"), and WebGL2 accepts it without
   * complaint. WebGPU rejects it outright: `Vertex buffer arrayStride (2) is not a multiple of 4`,
   * the pipeline is invalid, and in the RELEASE engine build nothing is reported.
   *
   * So the same bytes that upload zero-copy on WebGL2 cannot be bound on WebGPU at all. Padding
   * the channel to two components costs 2 extra bytes per point of VRAM and one CPU pass over the
   * whole cloud, which is precisely the per-point JavaScript the container was designed to avoid.
   * It is done here rather than hidden, `repacked` reports it, and the right long-term fix is for
   * the container to store `segment` as 4 bytes.
   */
  const needsSegmentPadding = device.isWebGPU === true;
  const segmentComponents = needsSegmentPadding ? 2 : 1;

  // Non-interleaved (planar) format. The third argument is what selects it, and it makes the
  // element offsets a function of the vertex count, which is why the format is built per cloud.
  const format = new pc.VertexFormat(
    device,
    [
      { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 },
      { semantic: pc.SEMANTIC_COLOR, components: 4, type: pc.TYPE_UINT8, normalize: true },
      {
        semantic: pc.SEMANTIC_ATTR8,
        components: segmentComponents,
        type: pc.TYPE_UINT16,
        normalize: false,
      },
    ],
    n,
  );

  const packed = needsSegmentPadding ? padSegmentChannel(map) : packedVertexBytes(map);
  const vertexBuffer = new pc.VertexBuffer(device, format, n, {
    usage: pc.BUFFER_STATIC,
    data: packed.bytes as unknown as ArrayBuffer,
  });

  const mesh = new pc.Mesh(device);
  mesh.vertexBuffer = vertexBuffer;
  mesh.primitive[0] = { type: pc.PRIMITIVE_POINTS, base: 0, count: n, indexed: false, baseVertex: 0 };

  const { min, max } = map.header.bounds;
  mesh.aabb = new pc.BoundingBox();
  mesh.aabb.setMinMax(new pc.Vec3(min[0], min[1], min[2]), new pc.Vec3(max[0], max[1], max[2]));

  const blend = options.blend ?? false;
  const material = new pc.ShaderMaterial(buildShaderDesc(blend) as ConstructorParameters<typeof pc.ShaderMaterial>[0]);
  material.cull = pc.CULLFACE_NONE;
  if (blend) {
    material.blendType = pc.BLEND_NORMAL;
    material.depthWrite = false;
  } else {
    material.blendType = pc.BLEND_NONE;
    material.depthWrite = true;
  }
  material.depthTest = true;

  const footprint = footprintRadiusOf(map.header);

  // ARRAY UNIFORMS TAKE A "[0]" SUFFIX, AND GETTING IT WRONG IS SILENT.
  //
  // PlayCanvas registers an array uniform in the device scope under `name[0]`, matching the name
  // WebGL reflection reports (`UniformFormat` does `this.name = count ? name + '[0]' : name`, and
  // the engine's own forward renderer resolves `pcssDiskSamples[0]`). `setParameter('uSegState',
  // ...)` therefore binds nothing at all, no warning is produced, and the shader reads a table of
  // zeros: every segment comes back unconfirmed=0, presenceOnly=0, confidence floor 0.
  //
  // The visible symptom is the one that matters most in this product. presenceOnly 0 means the
  // person points are NOT discarded, so people get baked into the geometry as reconstructions
  // instead of rendering as time-anchored presence markers. The scene looks fine. It is lying.
  material.setParameter('uSegState[0]', packSemantics(semantics));
  const setTheme = (theme: PresentationTheme): void => {
    material.setParameter('uPalette[0]', pointProvenancePalette(theme));
    material.setParameter('uFogColor', [...unitRgb(theme.ground)]);
    material.update();
  };
  setTheme(options.theme ?? BLUE_HOUR_THEME);
  // Fog starts at the footprint boundary rather than inside it, so the island's own body is not
  // washed out and the ramp lands where the dissolve band already is.
  material.setParameter('uFog', [footprint * 0.9, footprint * 3.2, 1.2, 1]);
  material.setParameter('uExposure', 1.25);
  material.setParameter('uPoint', [options.sizeGain ?? DEFAULT_SIZE_GAIN, options.maxSizePx ?? DEFAULT_MAX_SIZE_PX, 900, 0]);
  material.setParameter('uIsland', [
    1,
    footprint,
    // The dissolve band start, from atlas-core's constant rather than a number typed here. The
    // band is a product decision; the shader is only allowed to render it.
    footprint * (1 - DISSOLVE_BAND_FRACTION),
    1,
  ]);
  material.update();

  if (semantics.some((s) => s.id >= MAX_SEGMENTS)) {
    throw new RangeError(`segment id exceeds the ${MAX_SEGMENTS}-entry semantic table`);
  }

  return {
    mesh,
    material,
    vertexBuffer,
    pointCount: n,
    footprintRadiusLocal: footprint,
    repacked: packed.copied,
    vertexBytes: vertexBuffer.numBytes,
    defaultSizeGain: options.sizeGain ?? DEFAULT_SIZE_GAIN,
    defaultMaxSizePx: options.maxSizePx ?? DEFAULT_MAX_SIZE_PX,
    setTheme,
    destroy(): void {
      mesh.destroy();
      material.destroy();
    },
  };
}

/**
 * Reading the `.opm` container that `@orimera/scene-synth` writes.
 *
 * The boundary contract forbids this package from importing scene-synth, so the container is
 * re-described here from its documented layout rather than shared as a type. That duplication is
 * deliberate and it is the point: the bake-off has to prove that a renderer binding can load the
 * bytes with no build-time coupling to the tool that produced them.
 *
 * THE ONE REQUIREMENT: no per-point JavaScript. Parsing cost must not land inside a number that
 * is supposed to be about rendering. Everything below is a header parse plus three typed-array
 * views over the same ArrayBuffer.
 */

export interface OpmSection {
  readonly name: 'position' | 'color' | 'segment';
  readonly type: 'float32' | 'uint8' | 'uint16';
  readonly components: number;
  readonly normalized: boolean;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface OpmSegment {
  readonly id: number;
  readonly name: string;
  /** ground / water / structure / object / person / vegetation. Drives semantic appearance. */
  readonly cls: string;
}

export interface OpmHeader {
  readonly format: 'orimera-point-map';
  readonly version: number;
  readonly pointCount: number;
  readonly rung: 3;
  readonly metric: boolean;
  readonly viewpoint: {
    readonly position: readonly [number, number, number];
    readonly forward: readonly [number, number, number];
    readonly fovYDeg: number;
  };
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** The alpha channel of `color` is CONFIDENCE, not opacity. Stated in the file, not inferred. */
  readonly colorAlpha: 'confidence';
  readonly segments: readonly OpmSegment[];
  readonly sections: readonly OpmSection[];
}

export interface PointMap {
  readonly header: OpmHeader;
  /** The whole file. Kept so a VertexBuffer can be built over it without copying. */
  readonly buffer: ArrayBuffer;
  readonly position: Float32Array;
  readonly color: Uint8Array;
  readonly segment: Uint16Array;

  /**
   * True when the three sections sit back to back with no inter-section padding, in the order
   * position, colour, segment.
   *
   * This matters because PlayCanvas holds exactly ONE VertexBuffer per Mesh and computes its own
   * offsets for a non-interleaved format (tightly packed, in declaration order). It cannot be
   * told to read three attributes from three unrelated offsets. When this is true the binding can
   * hand the engine a zero-copy view of the file; when it is false it must repack, which is a
   * per-point CPU pass and is reported rather than hidden.
   */
  readonly planarContiguous: boolean;
  /** Byte offset of the position section, which is the start of the packed region when contiguous. */
  readonly packedByteOffset: number;
  readonly packedByteLength: number;
}

const MAGIC = 'OPM1';

function sectionOf(header: OpmHeader, name: OpmSection['name']): OpmSection {
  const s = header.sections.find((x) => x.name === name);
  if (s === undefined) throw new Error(`.opm is missing its "${name}" section`);
  return s;
}

export function decodeOpm(buffer: ArrayBuffer): PointMap {
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  if (magic !== MAGIC) throw new Error(`not an .opm file: magic was "${magic}"`);

  const headerLength = new DataView(buffer).getUint32(4, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)),
  ) as OpmHeader;

  if (header.format !== 'orimera-point-map') {
    throw new Error(`unexpected .opm format field: ${String(header.format)}`);
  }

  const pos = sectionOf(header, 'position');
  const col = sectionOf(header, 'color');
  const seg = sectionOf(header, 'segment');
  const n = header.pointCount;

  // The engine's packed planar layout, for comparison against the file's actual offsets.
  const stridePos = 12 * n;
  const strideCol = 4 * n;

  const planarContiguous =
    col.byteOffset - pos.byteOffset === stridePos &&
    seg.byteOffset - pos.byteOffset === stridePos + strideCol;

  return {
    header,
    buffer,
    position: new Float32Array(buffer, pos.byteOffset, n * 3),
    color: new Uint8Array(buffer, col.byteOffset, n * 4),
    segment: new Uint16Array(buffer, seg.byteOffset, n),
    planarContiguous,
    packedByteOffset: pos.byteOffset,
    packedByteLength: 18 * n,
  };
}

/**
 * A zero-copy byte view of the packed planar region, or a repacked copy when the file's sections
 * are not contiguous.
 *
 * Returns the view and whether a copy happened, because "did the loader touch every point" is a
 * fact the bake-off has to report rather than assume.
 */
export function packedVertexBytes(map: PointMap): { bytes: Uint8Array; copied: boolean } {
  if (map.planarContiguous) {
    return {
      bytes: new Uint8Array(map.buffer, map.packedByteOffset, map.packedByteLength),
      copied: false,
    };
  }
  const n = map.header.pointCount;
  const out = new Uint8Array(18 * n);
  out.set(new Uint8Array(map.position.buffer, map.position.byteOffset, 12 * n), 0);
  out.set(map.color, 12 * n);
  out.set(new Uint8Array(map.segment.buffer, map.segment.byteOffset, 2 * n), 16 * n);
  return { bytes: out, copied: true };
}

/** Radial extent of the point map about its local origin, on the ground plane. */
export function footprintRadiusOf(header: OpmHeader): number {
  const { min, max } = header.bounds;
  return Math.max(
    Math.hypot(min[0], min[2]),
    Math.hypot(max[0], max[2]),
    Math.hypot(min[0], max[2]),
    Math.hypot(max[0], min[2]),
  );
}

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
  readonly frame: 'local';
  readonly up: '+Y';
  readonly forward: '-Z';
  readonly units: 'metres';
  readonly metric: boolean;
  readonly viewpoint: {
    readonly position: readonly [number, number, number];
    readonly forward: readonly [number, number, number];
    readonly up: readonly [number, number, number];
    readonly fovYDeg: number;
    readonly aspect: number;
  };
  readonly sourceImage: { readonly width: number; readonly height: number };
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** The alpha channel of `color` is CONFIDENCE, not opacity. Stated in the file, not inferred. */
  readonly colorAlpha: 'confidence';
  readonly segments: readonly OpmSegment[];
  readonly sections: readonly OpmSection[];
  /**
   * What the producer measured about the map, keyed by name. Optional, because the format has
   * always allowed a producer to report nothing, and a reader must not require a number that a
   * writer never claimed to have measured.
   *
   * `medianSampleSpacingM` is the one the renderer reads: it is the denominator the alpha channel
   * is a ratio of, and its presence is what says the alpha is a spacing ratio rather than an
   * opaque per-point confidence.
   */
  readonly statistics?: Readonly<Record<string, number>>;
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

function finiteVector(value: unknown, name: string): asserts value is readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error(`.opm ${name} must be three finite numbers`);
  }
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`.opm ${name} must be a positive integer`);
  }
}

function validateHeader(header: OpmHeader): void {
  if (header.version !== 1) throw new Error(`unsupported .opm version: ${String(header.version)}`);
  if (header.rung !== 3) throw new Error('.opm point maps must declare rung 3');
  if (header.frame !== 'local' || header.up !== '+Y' || header.forward !== '-Z' || header.units !== 'metres') {
    throw new Error('.opm has an unsupported local-frame convention');
  }
  if (typeof header.metric !== 'boolean') throw new Error('.opm metric must be an explicit boolean');
  if (!Number.isSafeInteger(header.pointCount) || header.pointCount < 0) {
    throw new Error('.opm pointCount must be a non-negative integer');
  }
  if (header.colorAlpha !== 'confidence') throw new Error('.opm color alpha is not confidence');
  finiteVector(header.viewpoint?.position, 'viewpoint.position');
  finiteVector(header.viewpoint?.forward, 'viewpoint.forward');
  finiteVector(header.viewpoint?.up, 'viewpoint.up');
  if (header.viewpoint.forward.some((x, i) => x !== [0, 0, -1][i]) ||
      header.viewpoint.up.some((x, i) => x !== [0, 1, 0][i])) {
    throw new Error('.opm source-camera axes do not match the renderer frame');
  }
  if (!Number.isFinite(header.viewpoint.fovYDeg) || header.viewpoint.fovYDeg < 1 || header.viewpoint.fovYDeg >= 179) {
    throw new Error('.opm viewpoint field of view is outside the camera range');
  }
  positiveInteger(header.sourceImage?.width, 'sourceImage.width');
  positiveInteger(header.sourceImage?.height, 'sourceImage.height');
  const expectedAspect = header.sourceImage.width / header.sourceImage.height;
  if (!Number.isFinite(header.viewpoint.aspect) || Math.abs(header.viewpoint.aspect - expectedAspect) > expectedAspect * 1e-6) {
    throw new Error('.opm viewpoint aspect does not match its source image');
  }
  finiteVector(header.bounds?.min, 'bounds.min');
  finiteVector(header.bounds?.max, 'bounds.max');
  if (header.bounds.min.some((x, i) => x > header.bounds.max[i]!)) {
    throw new Error('.opm bounds are inverted');
  }
}

function sectionOf(header: OpmHeader, name: OpmSection['name']): OpmSection {
  const s = header.sections.find((x) => x.name === name);
  if (s === undefined) throw new Error(`.opm is missing its "${name}" section`);
  return s;
}

export function decodeOpm(buffer: ArrayBuffer): PointMap {
  if (buffer.byteLength < 8) throw new Error('not an .opm file: container is shorter than its prefix');
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  if (magic !== MAGIC) throw new Error(`not an .opm file: magic was "${magic}"`);

  const headerLength = new DataView(buffer).getUint32(4, true);
  if (headerLength === 0 || headerLength > 1_048_576 || 8 + headerLength > buffer.byteLength) {
    throw new Error('.opm header length is outside the container');
  }
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)),
  ) as OpmHeader;

  if (header.format !== 'orimera-point-map') {
    throw new Error(`unexpected .opm format field: ${String(header.format)}`);
  }
  validateHeader(header);

  const pos = sectionOf(header, 'position');
  const col = sectionOf(header, 'color');
  const seg = sectionOf(header, 'segment');
  const n = header.pointCount;

  const expected = [
    [pos, 'float32', 3, false, 12],
    [col, 'uint8', 4, true, 4],
    [seg, 'uint16', 1, false, 2],
  ] as const;
  if (header.sections.length !== 3) throw new Error('.opm requires exactly three sections');
  for (const [section, type, components, normalized, stride] of expected) {
    if (section.type !== type || section.components !== components || section.normalized !== normalized ||
        !Number.isSafeInteger(section.byteOffset) || section.byteOffset < 8 + headerLength ||
        section.byteLength !== n * stride || section.byteOffset + section.byteLength > buffer.byteLength) {
      throw new Error(`.opm ${section.name} section layout or range is invalid`);
    }
  }
  if (pos.byteOffset % 4 !== 0 || seg.byteOffset % 2 !== 0) {
    throw new Error('.opm sections are not typed-array aligned');
  }

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

export interface SourcePanelEnvelope {
  readonly nearDepth: number;
  readonly farDepth: number;
  readonly nearHalfWidth: number;
  readonly nearHalfHeight: number;
  readonly farHalfWidth: number;
  readonly farHalfHeight: number;
}

/**
 * The exact source-camera frustum occupied by an OPM's declared depth range.
 *
 * This is an observed source-panel envelope, not a navigation envelope and not Atlas placement.
 * A renderer may use it to size the panel and initial view; it may not infer traversable space.
 */
export function sourcePanelEnvelopeOf(header: OpmHeader): SourcePanelEnvelope {
  const cameraZ = header.viewpoint.position[2];
  const nearDepth = Math.max(0, cameraZ - header.bounds.max[2]);
  const farDepth = Math.max(nearDepth, cameraZ - header.bounds.min[2]);
  const tangent = Math.tan((header.viewpoint.fovYDeg * Math.PI) / 360);
  return Object.freeze({
    nearDepth,
    farDepth,
    nearHalfWidth: nearDepth * tangent * header.viewpoint.aspect,
    nearHalfHeight: nearDepth * tangent,
    farHalfWidth: farDepth * tangent * header.viewpoint.aspect,
    farHalfHeight: farDepth * tangent,
  });
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

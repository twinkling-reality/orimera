import type { PointMap } from '../pointmap.js';
import type { Segment } from '../primitives.js';

/**
 * THE INTERCHANGE FORMAT, AND WHY IT IS THIS ONE.
 *
 * `.opm` (Orimera Point Map): a 16-byte-aligned binary container holding a JSON header followed
 * by planar typed-array sections. One file, one fetch, zero parsing.
 *
 * The requirement is narrow and it is not "a good point cloud format". It is: BOTH RENDERER
 * BINDINGS IN ADR-0003 MUST LOAD THE SAME BYTES AT THE SAME COST. The bake-off measures render
 * performance. Any format whose decode cost differs between three.js and PlayCanvas puts loader
 * engineering into a number that is supposed to be about rendering, and the ADR would then be
 * decided partly by whose parser is better, which is not the question.
 *
 * What that buys, concretely: `fetch` -> `arrayBuffer()` -> three `subarray` views ->
 * `new THREE.BufferAttribute(view, n)` or `new pc.VertexBuffer(device, format, count, {data:
 * view})`. Neither engine touches a point individually on the CPU. Sections are 16-byte aligned
 * so the views are zero-copy in both.
 *
 * REJECTED, with reasons:
 *
 *   PLY (binary or ASCII). The obvious choice and the wrong one here. Both engines can read it,
 *   but through different loaders with different per-point JavaScript parses, and custom
 *   properties (segment id, confidence) are exactly where those loaders diverge most. It is kept
 *   as an OPTIONAL SIDE OUTPUT for eyeballing in MeshLab or SuperSplat, because being able to
 *   look at the fixture matters and PLY is what the tools read.
 *
 *   SOG (meta.json plus lossless WebP). ADR-0003 fixes SOG as the delivery format and it is the
 *   right choice THERE, but SOG describes GAUSSIAN SPLATS: position, scale, rotation, opacity,
 *   spherical harmonics. This generator produces a POINT MAP, which is rung 3 on the
 *   reconstruction ladder and explicitly not splats (product-specification.md section 5).
 *   Encoding points as degenerate splats would misrepresent the rung and would tilt the bake-off
 *   toward whichever engine has the better splat path, when the point of measuring rung 3 is
 *   that it is the guaranteed floor with no gate that can fail. When experiment X-1 produces a
 *   real splat, the bake-off should load real SOG alongside this.
 *
 *   glTF / GLB with a POINTS primitive. Standard, and genuinely viable. Rejected because the
 *   segment id and confidence become non-standard `_SEGMENT` / `_CONFIDENCE` attributes that
 *   both loaders need custom plumbing for, and because PlayCanvas's glTF loader constructs a
 *   full entity and mesh graph on the way in. More moving parts inside the measurement, no gain.
 *   `.opm` is deliberately GLB-shaped (magic, length-prefixed JSON header, aligned binary
 *   sections) so moving to glTF later is a re-wrapping rather than a rewrite.
 *
 *   A separate `meta.json` sidecar. Rejected for the primary file: a second HTTP request adds
 *   variable latency to load timings. The header IS written out separately as `<name>.meta.json`
 *   for tooling and for humans, but the `.opm` is self-contained and the sidecar is never needed
 *   to read it.
 *
 * COST: 18 bytes per point. 4.5 MB at 250k, 72 MB at 4M. Positions are float32 rather than
 * quantised because a quantisation grid would flatten exactly the depth noise the fixture exists
 * to reproduce. If upload bandwidth ever needs to be measured separately, add a quantised
 * variant as a second section type rather than changing this one.
 */

export const OPM_MAGIC = 'OPM1';
export const OPM_VERSION = 1;
const ALIGNMENT = 16;

export type SectionType = 'float32' | 'uint8' | 'uint16';

export interface OpmSection {
  readonly name: 'position' | 'color' | 'segment';
  readonly type: SectionType;
  readonly components: number;
  readonly normalized: boolean;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface OpmViewpoint {
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly fovYDeg: number;
  readonly aspect: number;
}

export interface OpmHeader {
  readonly format: 'orimera-point-map';
  readonly version: number;
  readonly generator: string;
  readonly seed: number;
  readonly sceneName: string;
  readonly pointCount: number;
  /** The reconstruction rung this fixture stands in for. A single photo earns rung 3. */
  readonly rung: 3;
  readonly frame: 'local';
  readonly up: '+Y';
  readonly forward: '-Z';
  readonly units: 'metres';
  readonly metric: boolean;
  /** Where the camera stood. Everything not visible from here is honestly absent. */
  readonly viewpoint: OpmViewpoint;
  readonly sourceImage: { readonly width: number; readonly height: number };
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** Documents that the colour buffer's alpha channel carries per-point confidence, not opacity. */
  readonly colorAlpha: 'confidence';
  readonly segments: readonly {
    readonly id: number;
    readonly name: string;
    readonly cls: string;
  }[];
  readonly sections: readonly OpmSection[];
  readonly statistics: Readonly<Record<string, number>>;
}

export interface OpmMetadata {
  readonly generator: string;
  readonly seed: number;
  readonly sceneName: string;
  readonly viewpoint: OpmViewpoint;
  readonly sourceImage: { readonly width: number; readonly height: number };
  readonly metric: boolean;
  readonly segments: readonly Segment[];
  readonly statistics: Readonly<Record<string, number>>;
}

const align = (n: number): number => Math.ceil(n / ALIGNMENT) * ALIGNMENT;

export function encodeOpm(points: PointMap, meta: OpmMetadata): Uint8Array {
  const sizes = {
    position: points.count * 3 * 4,
    color: points.count * 4,
    segment: points.count * 2,
  };

  // Two passes: lay out the sections against a placeholder header, then rewrite the header with
  // the real offsets. The header is padded to a fixed length so the second pass cannot move it.
  const buildHeader = (sections: readonly OpmSection[]): OpmHeader => ({
    format: 'orimera-point-map',
    version: OPM_VERSION,
    generator: meta.generator,
    seed: meta.seed,
    sceneName: meta.sceneName,
    pointCount: points.count,
    rung: 3,
    frame: 'local',
    up: '+Y',
    forward: '-Z',
    units: 'metres',
    metric: meta.metric,
    viewpoint: meta.viewpoint,
    sourceImage: meta.sourceImage,
    bounds: { min: points.min, max: points.max },
    colorAlpha: 'confidence',
    segments: meta.segments.map((s) => ({ id: s.id, name: s.name, cls: s.cls })),
    sections,
    statistics: meta.statistics,
  });

  const placeholder: OpmSection[] = [
    { name: 'position', type: 'float32', components: 3, normalized: false, byteOffset: 0, byteLength: sizes.position },
    { name: 'color', type: 'uint8', components: 4, normalized: true, byteOffset: 0, byteLength: sizes.color },
    { name: 'segment', type: 'uint16', components: 1, normalized: false, byteOffset: 0, byteLength: sizes.segment },
  ];

  const probe = new TextEncoder().encode(JSON.stringify(buildHeader(placeholder)));
  // Reserve room for the offsets, which are the only thing that grows on the second pass.
  const headerCapacity = align(probe.length + 96);
  const dataStart = 8 + headerCapacity;

  let cursor = dataStart;
  const sections: OpmSection[] = placeholder.map((s) => {
    const byteOffset = align(cursor);
    cursor = byteOffset + s.byteLength;
    return { ...s, byteOffset };
  });

  const headerBytes = new TextEncoder().encode(JSON.stringify(buildHeader(sections)));
  if (headerBytes.length > headerCapacity) {
    throw new Error('opm header exceeded its reserved capacity');
  }

  const total = align(cursor);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out.set(new TextEncoder().encode(OPM_MAGIC), 0);
  view.setUint32(4, headerBytes.length, true);
  out.set(headerBytes, 8);
  // Pad the header region with spaces so the JSON stays readable in a hex dump.
  out.fill(0x20, 8 + headerBytes.length, dataStart);

  out.set(new Uint8Array(points.position.buffer, points.position.byteOffset, sizes.position), sections[0]!.byteOffset);
  out.set(points.color, sections[1]!.byteOffset);
  out.set(new Uint8Array(points.segment.buffer, points.segment.byteOffset, sizes.segment), sections[2]!.byteOffset);

  return out;
}

export interface DecodedOpm {
  readonly header: OpmHeader;
  readonly position: Float32Array;
  readonly color: Uint8Array;
  readonly segment: Uint16Array;
}

/**
 * Reference decoder. Both renderer bindings should read the file this way: three subarray views
 * over one ArrayBuffer, no per-point work.
 */
export function decodeOpm(buffer: ArrayBuffer): DecodedOpm {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== OPM_MAGIC) throw new Error(`not an .opm file: magic was ${JSON.stringify(magic)}`);

  const headerLength = new DataView(buffer).getUint32(4, true);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)),
  ) as OpmHeader;
  if (header.version !== OPM_VERSION) {
    throw new Error(`unsupported .opm version ${header.version}`);
  }

  const find = (name: OpmSection['name']): OpmSection => {
    const s = header.sections.find((x) => x.name === name);
    if (s === undefined) throw new Error(`.opm is missing the ${name} section`);
    return s;
  };

  const pos = find('position');
  const col = find('color');
  const seg = find('segment');

  return {
    header,
    position: new Float32Array(buffer, pos.byteOffset, pos.byteLength / 4),
    color: new Uint8Array(buffer, col.byteOffset, col.byteLength),
    segment: new Uint16Array(buffer, seg.byteOffset, seg.byteLength / 2),
  };
}

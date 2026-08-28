/**
 * The `.opm` reader. Zero parse, zero per-point CPU work.
 *
 * scene-synth owns the writer and documents the container; this is the read half, duplicated
 * deliberately. `.dependency-cruiser.cjs` rule `scene-synth-is-offline-only` forbids anything
 * that ships to a browser from importing scene-synth, and that rule is correct: scene-synth
 * imports `node:fs`. So the field offsets are re-declared here rather than shared. The magic and
 * the version are checked at load precisely because the declaration is duplicated, which turns a
 * silent drift into a loud throw.
 *
 * `fetch` -> `arrayBuffer()` -> three typed-array views. Nothing iterates a point.
 */

export const OPM_MAGIC = 'OPM1';
export const OPM_VERSION = 1;

export interface OpmSectionRef {
  readonly name: 'position' | 'color' | 'segment';
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface OpmSegment {
  readonly id: number;
  readonly name: string;
  /** 'ground' | 'water' | 'structure' | 'object' | 'person' | 'vegetation' | 'sky'. */
  readonly cls: string;
}

export interface OpmHeader {
  readonly format: string;
  readonly version: number;
  readonly pointCount: number;
  readonly rung: number;
  readonly metric: boolean;
  readonly viewpoint: {
    readonly position: readonly [number, number, number];
    readonly forward: readonly [number, number, number];
    readonly fovYDeg: number;
  };
  readonly sourceImage: { readonly width: number; readonly height: number };
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** The writer asserts this is `"confidence"`. Checked, because the shader depends on it. */
  readonly colorAlpha: string;
  readonly segments: readonly OpmSegment[];
  readonly sections: readonly OpmSectionRef[];
  readonly statistics: Readonly<Record<string, number>>;
}

export interface PointMapData {
  readonly header: OpmHeader;
  /** Local frame, metres, +Y up, -Z forward. 3 floats per point. */
  readonly position: Float32Array;
  /** RGB plus ALPHA = per-point confidence, not opacity. 4 bytes per point, normalized. */
  readonly color: Uint8Array;
  /** Semantic label id, indexes `header.segments`. */
  readonly segment: Uint16Array;
  /** Bytes on the wire, for the bake-off's transfer column. */
  readonly byteLength: number;
}

function section(header: OpmHeader, name: OpmSectionRef['name']): OpmSectionRef {
  const s = header.sections.find((x) => x.name === name);
  if (s === undefined) throw new Error(`.opm is missing the '${name}' section`);
  return s;
}

/** Decode an already-fetched buffer. Separated from `fetchPointMap` so the timing can be split. */
export function decodeOpm(buffer: ArrayBuffer): PointMapData {
  if (buffer.byteLength < 8) throw new Error('.opm truncated: shorter than its own magic');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== OPM_MAGIC) throw new Error(`.opm bad magic: expected ${OPM_MAGIC}, got ${magic}`);

  const headerLength = view.getUint32(4, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)),
  ) as OpmHeader;

  if (header.version !== OPM_VERSION) {
    throw new Error(`.opm version ${header.version}, this reader speaks ${OPM_VERSION}`);
  }
  if (header.colorAlpha !== 'confidence') {
    // The point material multiplies vertex alpha into per-point dissolve. If a future writer
    // ever means opacity by that channel, every confidence-driven appearance in this binding
    // becomes a lie, so it fails loudly rather than rendering something plausible.
    throw new Error(
      `.opm colorAlpha is '${header.colorAlpha}', expected 'confidence'; the point material ` +
        'reads that channel as per-point reconstruction confidence',
    );
  }

  const n = header.pointCount;
  const pos = section(header, 'position');
  const col = section(header, 'color');
  const seg = section(header, 'segment');

  return Object.freeze({
    header,
    position: new Float32Array(buffer, pos.byteOffset, n * 3),
    color: new Uint8Array(buffer, col.byteOffset, n * 4),
    segment: new Uint16Array(buffer, seg.byteOffset, n),
    byteLength: buffer.byteLength,
  });
}

export interface FetchTimings {
  /** Network plus disk, to the last byte. */
  readonly fetchMs: number;
  /** Header parse plus three typed-array view constructions. Expected to be near zero. */
  readonly decodeMs: number;
}

export async function fetchPointMap(
  url: string,
  signal?: AbortSignal,
): Promise<{ data: PointMapData; timings: FetchTimings }> {
  const t0 = performance.now();
  const response = await fetch(url, signal === undefined ? {} : { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const t1 = performance.now();
  const data = decodeOpm(buffer);
  const t2 = performance.now();
  return { data, timings: Object.freeze({ fetchMs: t1 - t0, decodeMs: t2 - t1 }) };
}

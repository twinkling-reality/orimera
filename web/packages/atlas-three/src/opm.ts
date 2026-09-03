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
 *
 * **This reads OPM/2.** ADR-0010 gave the container a version and both of its writers moved, so a
 * reader left at version 1 would be a binding that can no longer open any file this product
 * produces. This package is ADR-0003's option A and ADR-0003 chose PlayCanvas, so it is the
 * losing candidate rather than a shipped path; it is carried forward anyway, because the ADR is
 * settled "by deleting a package rather than by unpicking one" and a package that quietly stopped
 * being able to read the format would be neither deleted nor working.
 */

export const OPM_MAGIC = 'OPM1';
export const OPM_VERSION = 2;
/** The version this one replaces, refused by name on read. ADR-0010 D9. */
export const SUPERSEDED_OPM_VERSION = 1;

/** Bit 0 of a point's flags channel: a neighbour of this point went to the silhouette drop. */
export const TAG_ONE_SIDED = 0x0001;

export interface OpmSectionRef {
  readonly name: string;
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
  /** The grid the points were unprojected from, which is not the photograph. ADR-0010 D6. */
  readonly modelImage: { readonly width: number; readonly height: number };
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /**
   * `support` or `confidence`, declared by the writer. Checked, because the shader depends on it.
   *
   * An enum since OPM/2. This binding's point material reads the channel as confidence, so it
   * refuses a file that says `support`: the honest answer for a reader that cannot present a
   * quantity is to say so, and the alternative is drawing coverage as though it were belief.
   */
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
  /** Two uint16 per point: the semantic label id, which indexes `header.segments`, then flags. */
  readonly tags: Uint16Array;
  /** Bytes on the wire, for the bake-off's transfer column. */
  readonly byteLength: number;
}

function section(header: OpmHeader, name: string): OpmSectionRef {
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

  if (header.version === SUPERSEDED_OPM_VERSION) {
    throw new Error(
      `.opm version ${SUPERSEDED_OPM_VERSION}, this reader speaks ${OPM_VERSION}. There is no `
        + 'upgrade on read: regenerate the file rather than converting it',
    );
  }
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
  const tags = section(header, 'tags');

  return Object.freeze({
    header,
    position: new Float32Array(buffer, pos.byteOffset, n * 3),
    color: new Uint8Array(buffer, col.byteOffset, n * 4),
    tags: new Uint16Array(buffer, tags.byteOffset, n * 2),
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

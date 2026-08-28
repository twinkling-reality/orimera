/**
 * A figure: the target positions the particle field is currently trying to hold.
 *
 * Coordinates are in **unit space**, centred on the composition, with y increasing downward to
 * match the canvas. One unit is half the smaller viewport dimension, so a figure is resolution
 * independent and the composition survives a window resize without being regenerated.
 */

/** Particle classes. The renderer draws a different sprite and alpha for each. */
export const KIND = {
  /** Ambient dust and between-space motes. Dim, small, always present. */
  MOTE: 0,
  /** Companion ring material and region accents. The iridescent accent colour. */
  RING: 1,
  /** The suspended luminous core. Few, bright, the only saturated highlight in the frame. */
  CORE: 2,
  /** Structure: camera frusta, continuity threads. Thin and cool. */
  STRUCTURE: 3,
  /**
   * Unconfirmed material. Renders with per-point dissolve driven by real semantic state
   * (`FormationVisual.dissolve`), never by a shader told to look mysterious.
   */
  UNCONFIRMED: 4,
} as const;

export type Kind = (typeof KIND)[keyof typeof KIND];

export interface Figure {
  readonly xy: Float32Array;
  readonly kind: Uint8Array;
  readonly count: number;
}

/** Accumulates points while a figure is built. */
export class FigureBuilder {
  private readonly xy: Float32Array;
  private readonly kinds: Uint8Array;
  private n = 0;

  constructor(private readonly capacity: number) {
    this.xy = new Float32Array(capacity * 2);
    this.kinds = new Uint8Array(capacity);
  }

  get length(): number {
    return this.n;
  }

  get remaining(): number {
    return this.capacity - this.n;
  }

  push(x: number, y: number, kind: Kind): void {
    if (this.n >= this.capacity) return;
    this.xy[this.n * 2] = x;
    this.xy[this.n * 2 + 1] = y;
    this.kinds[this.n] = kind;
    this.n += 1;
  }

  build(): Figure {
    return { xy: this.xy, kind: this.kinds, count: this.n };
  }
}

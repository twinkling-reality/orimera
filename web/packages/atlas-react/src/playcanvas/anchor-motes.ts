import * as pc from 'playcanvas';
import type { AnchorTable, EmphasisBuffers } from '@orimera/atlas-core';
import { readsAsUnconfirmed, rendersAsPresenceMarker } from '@orimera/atlas-core';
import type { ProvenanceClass } from '@orimera/atlas-core';
import {
  DAWN_THEME,
  byteRgba,
  type PresentationTheme,
} from '@orimera/presentation';

/**
 * One mote per anchor. What a region with no reconstructed geometry actually looks like.
 *
 * **Why this exists.** `rungProperties(4)` is "evidence cards laid out by time and semantic
 * proximity. No geometry." Rung 4 is a real rung with a defined movement model, not a failure
 * state, and until this file existed the binding rendered a rung 4 island as literally nothing:
 * a point cloud is built only when a point map is supplied, so a library with no reconstruction
 * was an empty void with a few DOM labels floating in it. A world that renders nothing cannot be
 * navigated, and "the geometry is honestly incomplete" is not the same claim as "there is no
 * geometry to see".
 *
 * **People are excluded, structurally.** `rendersAsPresenceMarker` is asked and never
 * second-guessed: a person anchor is a time-anchored presence marker drawn by the overlay, and
 * putting one in this cloud would be putting a person into world geometry. The exclusion is here
 * as well as in the overlay because the two halves are deliberately in different files: somebody
 * who disables the marker gets no person, rather than a silently reconstructed one.
 *
 * **Nothing here decides what anything means.** Colour comes from the provenance class and from
 * `readsAsUnconfirmed`, which is atlas-core's rule; size comes from the emphasis buffer the
 * manifest writes. There is no constant in this file that exists to look mysterious.
 */

/** World-space radius the mote subtends. Turned into pixels by the projection scale. */
const DEFAULT_SIZE_METRES = 0.14;
const DEFAULT_MAX_SIZE_PX = 11;
const MIN_SIZE_PX = 2;

/** Bytes per mote: position 12, colour 4, emphasis 4. */
const STRIDE = 20;

const ATTRIBUTES = {
  aPosition: pc.SEMANTIC_POSITION,
  aColor: pc.SEMANTIC_COLOR,
  aEmphasis: pc.SEMANTIC_ATTR8,
} as const;

const PROVENANCE_ALPHA: Readonly<Record<ProvenanceClass, number>> = Object.freeze({
  capture: 0.92,
  inference: 0.78,
  user: 0.96,
  external: 0.82,
});

export interface AnchorMotesOptions {
  readonly device: pc.GraphicsDevice;
  readonly table: AnchorTable;
  readonly sizeMetres?: number;
  readonly maxSizePx?: number;
  readonly theme?: PresentationTheme;
}

export interface AnchorMotes {
  readonly mesh: pc.Mesh;
  readonly material: pc.ShaderMaterial;
  readonly count: number;
  /** Indices into the anchor table, in mote order. Person anchors are absent by construction. */
  readonly anchorIndices: Int32Array;
  readonly uMote: Float32Array;
  /** Rewrite the emphasis channel from the current buffers. Cheap; see the note in `update`. */
  update(emphasis: EmphasisBuffers): void;
  setTheme(theme: PresentationTheme): void;
  destroy(): void;
}

export function anchorMoteRgba(
  theme: PresentationTheme,
  provenance: ProvenanceClass,
  unconfirmed: boolean,
): readonly [number, number, number, number] {
  const rgba = byteRgba(theme.provenance[provenance], PROVENANCE_ALPHA[provenance]);
  return [rgba[0], rgba[1], rgba[2], Math.round(rgba[3] * (unconfirmed ? 0.55 : 1))];
}

const VERTEX_GLSL = /* glsl */ `
attribute vec3 aPosition;
attribute vec4 aColor;
attribute float aEmphasis;

uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform vec3 view_position;

// x world size in metres, y max size in pixels, z projection scale in pixels, w min size px
uniform vec4 uMote;

varying vec4 vColor;
varying float vEmphasis;

void main(void) {
    vec4 world = matrix_model * vec4(aPosition, 1.0);
    gl_Position = matrix_viewProjection * world;

    // A constant WORLD footprint rather than a constant screen one, so walking toward a region
    // makes its motes grow the way anything real does. A constant screen size would make
    // distance unreadable, and distance is the only depth cue a mote cloud has.
    float dist = max(length(world.xyz - view_position), 0.001);
    float px = (uMote.x * uMote.z / dist) * (0.55 + 0.75 * aEmphasis);
    gl_PointSize = clamp(px, uMote.w, uMote.y);

    vColor = aColor;
    vEmphasis = aEmphasis;
}
`;

export const MOTE_FRAGMENT_GLSL = /* glsl */ `
precision highp float;

varying vec4 vColor;
varying float vEmphasis;

void main(void) {
    // A disc with a hard rim rather than a soft particulate blur. In this binding a soft edge
    // means "reconstructed surface"; a mote is a marker for a detection and must not read as one.
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r = dot(d, d);
    if (r > 1.0) discard;

    float rim = smoothstep(0.55, 1.0, r);
    vec3 rgb = mix(vColor.rgb, vColor.rgb * 1.35, rim);
    float alpha = vColor.a * (0.4 + 0.6 * clamp(vEmphasis, 0.0, 1.0));
    gl_FragColor = vec4(rgb, alpha);
}
`;

/** `ShaderDesc` is documented but not exported from the engine's type surface, so it is restated. */
interface ShaderDesc {
  uniqueName: string;
  attributes?: Record<string, string>;
  vertexGLSL?: string;
  fragmentGLSL?: string;
}

/**
 * Which anchors get a mote. Separated from the mesh so the rule can be tested without a GPU.
 *
 * A person is excluded, and that exclusion is the whole reason this is a named function rather
 * than three lines inside a constructor: putting a person in this cloud would put a person into
 * world geometry, and a rule that can only be checked by creating a graphics device is a rule
 * that does not get checked.
 *
 * `rendersAsPresenceMarker` is asked and never second-guessed. It lives in atlas-core as a
 * predicate over the anchor's kind precisely so it cannot be set false for a person by mistake.
 */
export function moteAnchorIndices(table: AnchorTable): Int32Array {
  const indices: number[] = [];
  for (let i = 0; i < table.count; i += 1) {
    const anchor = table.anchors[i];
    if (anchor === undefined || rendersAsPresenceMarker(anchor)) continue;
    indices.push(i);
  }
  return Int32Array.from(indices);
}

export function createAnchorMotes(options: AnchorMotesOptions): AnchorMotes {
  const { device, table } = options;

  const anchorIndices = moteAnchorIndices(table);
  const count = anchorIndices.length;

  const format = new pc.VertexFormat(device, [
    { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 },
    { semantic: pc.SEMANTIC_COLOR, components: 4, type: pc.TYPE_UINT8, normalize: true },
    { semantic: pc.SEMANTIC_ATTR8, components: 1, type: pc.TYPE_FLOAT32 },
  ]);
  const vertexBuffer = new pc.VertexBuffer(device, format, Math.max(1, count), {
    usage: pc.BUFFER_DYNAMIC,
  });

  const bytes = new Uint8Array(vertexBuffer.lock());
  const floats = new Float32Array(bytes.buffer);
  for (let m = 0; m < count; m += 1) {
    const index = anchorIndices[m] as number;
    const anchor = table.anchors[index]!;
    const base = (m * STRIDE) / 4;
    floats[base] = table.atlasPositions[index * 3] ?? 0;
    floats[base + 1] = table.atlasPositions[index * 3 + 1] ?? 0;
    floats[base + 2] = table.atlasPositions[index * 3 + 2] ?? 0;

    // An unconfirmed link is dimmer, and the rule for what counts as unconfirmed is atlas-core's.
    // id-2: an auto-provisional link may organise the world and may never support a claim, so it
    // is present and visibly not settled rather than absent or indistinguishable.
    const colour = anchorMoteRgba(
      options.theme ?? DAWN_THEME,
      anchor.provenance,
      readsAsUnconfirmed(anchor.linkState, anchor.provenance),
    );
    const offset = m * STRIDE + 12;
    bytes[offset] = colour[0];
    bytes[offset + 1] = colour[1];
    bytes[offset + 2] = colour[2];
    bytes[offset + 3] = colour[3];

    floats[base + 4] = 1;
  }
  vertexBuffer.unlock();

  const mesh = new pc.Mesh(device);
  mesh.vertexBuffer = vertexBuffer;
  mesh.primitive[0] = {
    type: pc.PRIMITIVE_POINTS,
    base: 0,
    baseVertex: 0,
    count,
    indexed: false,
  };

  const material = new pc.ShaderMaterial({
    uniqueName: 'orimera-anchor-motes',
    attributes: { ...ATTRIBUTES },
    vertexGLSL: VERTEX_GLSL,
    fragmentGLSL: MOTE_FRAGMENT_GLSL,
  } as ShaderDesc);
  material.blendType = pc.BLEND_NORMAL;
  material.depthWrite = false;
  material.cull = pc.CULLFACE_NONE;
  material.update();

  const uMote = new Float32Array([
    options.sizeMetres ?? DEFAULT_SIZE_METRES,
    options.maxSizePx ?? DEFAULT_MAX_SIZE_PX,
    900,
    MIN_SIZE_PX,
  ]);

  const setTheme = (theme: PresentationTheme): void => {
    if (count === 0) return;
    const view = new Uint8Array(vertexBuffer.lock());
    for (let m = 0; m < count; m += 1) {
      const index = anchorIndices[m] as number;
      const anchor = table.anchors[index]!;
      const colour = anchorMoteRgba(
        theme,
        anchor.provenance,
        readsAsUnconfirmed(anchor.linkState, anchor.provenance),
      );
      view.set(colour, m * STRIDE + 12);
    }
    vertexBuffer.unlock();
  };

  return {
    mesh,
    material,
    count,
    anchorIndices,
    uMote,
    setTheme,
    /**
     * Rewrite the emphasis channel.
     *
     * The whole buffer is relocked rather than a partial update, because the engine offers no
     * sub-range write and the cost is a few kilobytes: one anchor per detection, and a library of
     * a few hundred photographs has a few hundred detections. The ceiling worth knowing is that
     * this is linear in anchors and runs per frame, so a corpus two orders of magnitude larger
     * needs a dirty flag rather than this loop.
     */
    update(emphasis: EmphasisBuffers) {
      if (count === 0) return;
      const view = new Float32Array(vertexBuffer.lock());
      for (let m = 0; m < count; m += 1) {
        view[(m * STRIDE) / 4 + 4] = emphasis.anchorEmphasis[anchorIndices[m] as number] ?? 1;
      }
      vertexBuffer.unlock();
    },
    destroy() {
      vertexBuffer.destroy();
      mesh.destroy();
    },
  };
}

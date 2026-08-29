import * as pc from 'playcanvas';
import type { AnchorTable, EmphasisBuffers } from '@orimera/atlas-core';
import { readsAsUnconfirmed, rendersAsPresenceMarker } from '@orimera/atlas-core';

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
const DEFAULT_SIZE_METRES = 0.34;
const DEFAULT_MAX_SIZE_PX = 26;
const MIN_SIZE_PX = 3;

/** Bytes per mote: position 12, colour 4, emphasis 4. */
const STRIDE = 20;

const ATTRIBUTES = {
  aPosition: pc.SEMANTIC_POSITION,
  aColor: pc.SEMANTIC_COLOR,
  aEmphasis: pc.SEMANTIC_ATTR8,
} as const;

/**
 * The four provenance classes, as rgba. The same four the confirmation panel and the index use,
 * because one vocabulary everywhere is the rule and a fifth palette would be a fifth vocabulary.
 * Alpha is the resting opacity before emphasis and confirmation are applied.
 */
const PALETTE: Readonly<Record<string, readonly [number, number, number, number]>> = Object.freeze({
  capture: [242, 238, 226, 235],
  inference: [158, 176, 214, 200],
  user: [232, 202, 138, 245],
  external: [196, 176, 214, 210],
});

export interface AnchorMotesOptions {
  readonly device: pc.GraphicsDevice;
  readonly table: AnchorTable;
  readonly sizeMetres?: number;
  readonly maxSizePx?: number;
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
  destroy(): void;
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

const FRAGMENT_GLSL = /* glsl */ `
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

export function createAnchorMotes(options: AnchorMotesOptions): AnchorMotes {
  const { device, table } = options;

  // Person anchors are excluded here rather than filtered later. See the module comment.
  const indices: number[] = [];
  for (let i = 0; i < table.count; i += 1) {
    const anchor = table.anchors[i];
    if (anchor === undefined || rendersAsPresenceMarker(anchor)) continue;
    indices.push(i);
  }
  const anchorIndices = Int32Array.from(indices);
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

    const colour = PALETTE[anchor.provenance] ?? PALETTE['inference']!;
    // An unconfirmed link is dimmer, and the rule for what counts as unconfirmed is atlas-core's.
    // id-2: an auto-provisional link may organise the world and may never support a claim, so it
    // is present and visibly not settled rather than absent or indistinguishable.
    const dim = readsAsUnconfirmed(anchor.linkState, anchor.provenance) ? 0.55 : 1;
    const offset = m * STRIDE + 12;
    bytes[offset] = colour[0];
    bytes[offset + 1] = colour[1];
    bytes[offset + 2] = colour[2];
    bytes[offset + 3] = Math.round(colour[3] * dim);

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
    fragmentGLSL: FRAGMENT_GLSL,
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

  return {
    mesh,
    material,
    count,
    anchorIndices,
    uMote,
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

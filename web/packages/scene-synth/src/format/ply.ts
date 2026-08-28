import type { PointMap } from '../pointmap.js';

/**
 * Binary little-endian PLY, as an OPTIONAL SIDE OUTPUT for looking at the fixture.
 *
 * Not the interchange format (see the note at the top of `opm.ts`). It exists because MeshLab,
 * CloudCompare and SuperSplat read PLY and being able to open the fixture and judge whether it
 * looks like a place is worth a few megabytes of duplicated bytes on a developer's disk.
 *
 * `confidence` is written as a real property AND folded into `alpha`, so a viewer that ignores
 * custom properties still shows low-confidence points faded.
 */
export function encodePly(points: PointMap, comment: string): Uint8Array {
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `comment ${comment.replace(/\n/g, ' ')}\n` +
    'comment alpha carries per-point confidence, not opacity\n' +
    `element vertex ${points.count}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\n' +
    'property ushort segment\n' +
    'end_header\n';

  const headerBytes = new TextEncoder().encode(header);
  const stride = 12 + 4 + 2;
  const out = new Uint8Array(headerBytes.length + points.count * stride);
  out.set(headerBytes, 0);
  const view = new DataView(out.buffer, headerBytes.length);

  for (let i = 0; i < points.count; i += 1) {
    const o = i * stride;
    view.setFloat32(o, points.position[i * 3]!, true);
    view.setFloat32(o + 4, points.position[i * 3 + 1]!, true);
    view.setFloat32(o + 8, points.position[i * 3 + 2]!, true);
    out[headerBytes.length + o + 12] = points.color[i * 4]!;
    out[headerBytes.length + o + 13] = points.color[i * 4 + 1]!;
    out[headerBytes.length + o + 14] = points.color[i * 4 + 2]!;
    out[headerBytes.length + o + 15] = points.color[i * 4 + 3]!;
    view.setUint16(o + 16, points.segment[i]!, true);
  }

  return out;
}

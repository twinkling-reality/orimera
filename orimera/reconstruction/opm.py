"""Writing the ``.opm`` container, from Python, for the same decoder the fixtures feed.

``.opm`` had one producer, ``@orimera/scene-synth``, which writes synthetic fixtures for the
renderer bake-off. This is the second, and it writes what a real photograph turned out to have
been looking at. Both are read by the same decoder in ``@orimera/atlas-react``, which is the
point: the renderer cannot tell a synthetic fixture from a reconstruction, so a measurement taken
against the fixture is a measurement of the real path.

**The layout is contiguous on purpose, and that is not a detail.** The decoder reports
``planarContiguous`` and the PlayCanvas binding takes a zero-copy path when it is true and a
per-point CPU repack when it is false. PlayCanvas holds exactly one vertex buffer per mesh and
computes its own offsets for a tightly packed planar format, so it cannot be told to read three
attributes from three unrelated places. The TypeScript writer aligns every section to sixteen
bytes, which is contiguous only when the point count happens to be a multiple of four. This one
aligns the START of the position section and then packs colour and segment immediately after, so
the file is always on the fast path.

The alignment that remains is the alignment that matters: the position section starts on a
sixteen-byte boundary, so a `Float32Array` view over it is legal; colour is bytes and needs none;
and segment begins at that boundary plus sixteen bytes per point, which is even, so a
`Uint16Array` view over it is legal too.

**Two fields the synthetic writer has are absent here.** ``seed`` and ``sceneName`` describe a
generated world and there is no honest value for them over a photograph. They are omitted rather
than filled with a zero and an empty string, and the decoder does not read either.
"""

from __future__ import annotations

import json
from typing import Any, Final

from orimera.reconstruction.pointmap import PointMap

__all__ = ["OPM_MAGIC", "OPM_VERSION", "Viewpoint", "encode_opm"]

OPM_MAGIC: Final = b"OPM1"
OPM_VERSION: Final = 1
_ALIGNMENT: Final = 16

#: The rung a per-image monocular point map stands for. Fixed at 3 by the container itself: a
#: point map is not a splat and writing a 1 here would be describing a file this is not.
_POINT_MAP_RUNG: Final = 3


class Viewpoint:
    """Where the camera stood, in the point map's own frame.

    Always the origin looking down -Z for a monocular reconstruction, because the frame IS the
    camera's. It is written out rather than left implicit because the renderer dollies to it on
    first arrival, and because everything not visible from here is honestly absent: a 2.5D shell
    has observed surfaces on one side only, and a viewer placed anywhere else is looking at the
    back of a photograph.
    """

    __slots__ = ("aspect", "fov_y_degrees")

    def __init__(self, fov_y_degrees: float, aspect: float) -> None:
        self.fov_y_degrees = fov_y_degrees
        self.aspect = aspect

    def as_header(self) -> dict[str, Any]:
        return {
            "position": [0.0, 0.0, 0.0],
            "forward": [0.0, 0.0, -1.0],
            "up": [0.0, 1.0, 0.0],
            "fovYDeg": self.fov_y_degrees,
            "aspect": self.aspect,
        }


def _align(value: int) -> int:
    return -(-value // _ALIGNMENT) * _ALIGNMENT


def encode_opm(
    points: PointMap,
    *,
    generator: str,
    viewpoint: Viewpoint,
    source_size: tuple[int, int],
    metric: bool,
) -> bytes:
    """One point map to one self-contained file.

    ``metric`` is carried rather than assumed. A monocular model that recovers true scale writes
    True and a spatial question may be answered from the result; one that recovers shape up to an
    unknown scale writes False, and the island built from it is not metric, which is what makes
    `asMetricLocal` return null and the query path refuse with a stated reason instead of
    estimating a distance.
    """
    count = points.count
    sizes = (count * 12, count * 4, count * 2)

    def header_for(offsets: tuple[int, int, int]) -> dict[str, Any]:
        low, high = points.bounds()
        return {
            "format": "orimera-point-map",
            "version": OPM_VERSION,
            "generator": generator,
            "pointCount": count,
            "rung": _POINT_MAP_RUNG,
            "frame": "local",
            "up": "+Y",
            "forward": "-Z",
            "units": "metres",
            "metric": metric,
            "viewpoint": viewpoint.as_header(),
            "sourceImage": {"width": source_size[0], "height": source_size[1]},
            "bounds": {"min": list(low), "max": list(high)},
            "colorAlpha": "confidence",
            "segments": [
                {"id": s.id, "name": s.name, "cls": s.cls} for s in points.segments
            ],
            "sections": [
                {
                    "name": "position",
                    "type": "float32",
                    "components": 3,
                    "normalized": False,
                    "byteOffset": offsets[0],
                    "byteLength": sizes[0],
                },
                {
                    "name": "color",
                    "type": "uint8",
                    "components": 4,
                    "normalized": True,
                    "byteOffset": offsets[1],
                    "byteLength": sizes[1],
                },
                {
                    "name": "segment",
                    "type": "uint16",
                    "components": 1,
                    "normalized": False,
                    "byteOffset": offsets[2],
                    "byteLength": sizes[2],
                },
            ],
            "statistics": points.statistics,
        }

    # Two passes. The first measures a header carrying placeholder offsets; the second writes the
    # real ones into a region reserved to be large enough that they cannot move it. Reserving
    # rather than iterating, because a header that grew on the second pass would shift the very
    # offsets it was recording.
    probe = json.dumps(header_for((0, 0, 0)), separators=(",", ":")).encode("utf-8")
    capacity = _align(len(probe) + 96)
    position_offset = _align(8 + capacity)
    offsets = (
        position_offset,
        position_offset + sizes[0],
        position_offset + sizes[0] + sizes[1],
    )

    header = json.dumps(header_for(offsets), separators=(",", ":")).encode("utf-8")
    if len(header) > capacity:
        raise ValueError("the .opm header exceeded its reserved capacity")

    out = bytearray(offsets[2] + sizes[2])
    out[0:4] = OPM_MAGIC
    out[4:8] = len(header).to_bytes(4, "little")
    out[8 : 8 + len(header)] = header
    # Spaces rather than zeroes, so the JSON stays readable in a hex dump.
    for index in range(8 + len(header), position_offset):
        out[index] = 0x20
    out[position_offset:] = points.packed_bytes()
    return bytes(out)

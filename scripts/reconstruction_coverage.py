# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Top-down coverage of a single-view point map, decomposed by support and by frustum.

Measures, on a GxG grid over the X and Z extent of the point map header's bounding box, the
fraction of cells that hold any point, the fraction that hold a point whose support (colour
alpha) is at or above 0.25, the fraction whose centre lies inside the source camera's
horizontal field of view, and, over the part of the box within 20 m of the camera, the filled
cells as a share of the frustum cells. This is the table in docs/reconstruction-findings.md
section 2, at 12x12, 20x20 and 40x40. Measured on 2026-09-02 on the committed courtyard
fixture with the default input:

    .venv/bin/python scripts/reconstruction_coverage.py

Input: an `.opm` point map, given as the only argument. Version agnostic: it reads `position`
and `color` through the header's own section list, which is what ADR-0010 D2 makes authoritative,
so it worked unchanged across the OPM/1 to OPM/2 bump. Default, relative to the repository
root: web/packages/app/public/fixtures/memory/glasshouse-courtyard.opm. Standard library only.

Usage:  .venv/bin/python scripts/reconstruction_coverage.py [map.opm]
"""

import json
import math
import struct
import sys
from array import array
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_OPM = REPO / "web/packages/app/public/fixtures/memory/glasshouse-courtyard.opm"

if len(sys.argv) > 2:
    raise SystemExit("usage: reconstruction_coverage.py [map.opm]")
opm_path = Path(sys.argv[1]) if len(sys.argv) == 2 else DEFAULT_OPM
b = opm_path.read_bytes()
assert b[:4] == b"OPM1"
hl = struct.unpack_from("<I", b, 4)[0]
hdr = json.loads(b[8:8 + hl])
n = hdr["pointCount"]
secs = {s["name"]: s for s in hdr["sections"]}
pos = array("f")
pos.frombytes(b[secs["position"]["byteOffset"]:secs["position"]["byteOffset"] + n * 12])
col = b[secs["color"]["byteOffset"]:secs["color"]["byteOffset"] + n * 4]
alpha = [col[i * 4 + 3] / 255 for i in range(n)]
xs = pos[0::3]
zs = pos[2::3]
print("header keys:", sorted(hdr.keys()))
print("viewpoint:", hdr["viewpoint"])
print("bounds:", hdr["bounds"])
print("metric", hdr["metric"], "stats", hdr.get("statistics"))
fovy = hdr["viewpoint"]["fovYDeg"]
aspect = hdr["viewpoint"]["aspect"]
hfov = 2 * math.degrees(math.atan(math.tan(math.radians(fovy / 2)) * aspect))
print("hFoV deg", round(hfov, 2))


def cover(grid, minsup=None, maxdepth=None):
    """Filled cells, frustum cells and total cells of a grid over the box in X and Z."""
    lo = hdr["bounds"]["min"]
    hi = hdr["bounds"]["max"]
    xmin, xmax = lo[0], hi[0]
    zmin, zmax = lo[2], hi[2]
    if maxdepth is not None:
        zmin = max(zmin, -maxdepth)
    cw = (xmax - xmin) / grid
    ch = (zmax - zmin) / grid
    filled = set()
    for i in range(n):
        if minsup is not None and alpha[i] < minsup:
            continue
        if maxdepth is not None and -zs[i] > maxdepth:
            continue
        cx = min(grid - 1, int((xs[i] - xmin) / cw))
        cz = min(grid - 1, int((zs[i] - zmin) / ch))
        filled.add((cx, cz))
    # Frustum cells: cell centre inside the horizontal field of view from the origin looking -Z.
    wedge = 0
    half = math.radians(hfov / 2)
    for cx in range(grid):
        for cz in range(grid):
            x = xmin + (cx + 0.5) * cw
            z = zmin + (cz + 0.5) * ch
            if z < 0 and abs(math.atan2(x, -z)) <= half:
                wedge += 1
    return len(filled), wedge, grid * grid


for g in (12, 20, 40):
    f, w, t = cover(g)
    f25, _, _ = cover(g, minsup=0.25)
    f20d, w20, t20 = cover(g, maxdepth=20.0)
    print(f"grid {g}x{g}: filled {f}/{t} = {100 * f / t:.1f}% ; wedge cells {w} ({100 * w / t:.1f}%) ; "
          f"filled/wedge {100 * f / w:.1f}% ; support>=0.25 filled {f25} = {100 * f25 / t:.1f}% ; "
          f"depth<=20m box: filled {f20d}/{t20} = {100 * f20d / t20:.1f}%, wedge {w20}, filled/wedge {100 * f20d / w20:.1f}%")

# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Frustum-union upper bounds on top-down coverage, from camera poses alone.

Counts, on a GxG grid over the X and Z extent of the courtyard point map's bounding box, the
cells whose centre lies inside the horizontal field of view of at least one camera, optionally
only within a range of that camera. No surface is claimed: the count bounds what a set of poses
could have observed. Three pose sets: the source photograph alone (origin, looking -Z, 55.46
degrees horizontal); the eight synthetic views of docs/reconstruction-findings.md section 3 on
a 2.5 m arc, poses read from the spike directory's ground_truth.json (50 degrees vertical at
4:3); and hypothetical walks down the courtyard axis of 3, 5 and 8 stops 4 m apart, a
photograph forward and one back at each stop, at the source camera's field of view. These are
the bounds quoted in section 2. Measured on 2026-09-02 with:

    .venv/bin/python scripts/reconstruction_frustum_union.py <spike_dir>

The box is the courtyard fixture's header bounds as printed by reconstruction_coverage.py,
kept inline so this script needs no point map. The synthetic views are renders of a monocular
point map, not photographs; only their poses are used here. Standard library only.

Usage:  .venv/bin/python scripts/reconstruction_frustum_union.py <spike_dir>
  spike_dir: the directory written by reconstruction_synthetic_views.py; only ground_truth.json is read
"""

import json
import math
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("usage: reconstruction_frustum_union.py <spike_dir>")
SPIKE = Path(sys.argv[1])
with open(SPIKE / "ground_truth.json") as fh:
    gt = json.load(fh)

# Courtyard bounds from the .opm header, as printed by reconstruction_coverage.py.
xmin, xmax = -13.520286560058594, 2.1718130111694336
zmin, zmax = -35.81892395019531, -2.924398899078369


def wedge_union(cams, grid=12, maxrange=None):
    """Cells whose centre is inside at least one camera's horizontal wedge, and the cell total."""
    cw = (xmax - xmin) / grid
    ch = (zmax - zmin) / grid
    hit = 0
    for cx in range(grid):
        for cz in range(grid):
            x = xmin + (cx + 0.5) * cw
            z = zmin + (cz + 0.5) * ch
            ok = False
            for C, fwd, half in cams:
                dx = x - C[0]
                dz = z - C[2]
                d = math.hypot(dx, dz)
                if d == 0:
                    continue
                if maxrange and d > maxrange:
                    continue
                cos = (dx * fwd[0] + dz * fwd[2]) / d
                if cos >= math.cos(half):
                    ok = True
                    break
            if ok:
                hit += 1
    return hit, grid * grid


# Spike cameras: fovY 50 degrees at 4:3.
half_spike = math.atan(math.tan(math.radians(25)) * 4 / 3)
spike = []
for v in gt["views"]:
    C = v["C"]
    R = v["R_wc"]
    fwd = [R[0][2], R[1][2], R[2][2]]  # third column = camera forward in world
    spike.append((C, fwd, half_spike))
# Source photograph: origin, -Z, hFoV 55.46 degrees.
half_src = math.radians(55.46 / 2)
src = [([0, 0, 0], [0, 0, -1], half_src)]
for g in (12, 20, 40):
    h1, t = wedge_union(src, g)
    h8, _ = wedge_union(spike, g)
    h8r, _ = wedge_union(spike, g, maxrange=20)
    h1r, _ = wedge_union(src, g, maxrange=20)
    print(f"grid {g}: source wedge {h1}/{t}={100 * h1 / t:.1f}% ; 8-view 2.5 m arc union {h8}/{t}={100 * h8 / t:.1f}% ; "
          f"within 20 m: source {100 * h1r / t:.1f}% arc {100 * h8r / t:.1f}%")


# Hypothetical capture paths, poses only, no surfaces claimed: a walk down the courtyard axis.
def walk(n, step, yaw_deg=0.0):
    cams = []
    for i in range(n):
        C = [-5.7, 0, -3.0 - i * step]  # start near the source camera at the x-centre of the box, walk -Z
        for yaw in (yaw_deg, 180.0):  # a photograph forward and one looking back at each stop
            f = [math.sin(math.radians(yaw)), 0, -math.cos(math.radians(yaw))]
            cams.append((C, f, half_src))
    return cams


for n, step in ((3, 4.0), (5, 4.0), (8, 4.0)):
    h, t = wedge_union(walk(n, step), 12)
    hr, _ = wedge_union(walk(n, step), 12, maxrange=12)
    print(f"walk of {n} stops x2 photos, {step} m apart: wedge union {100 * h / t:.1f}% of box ; within 12 m of a camera {100 * hr / t:.1f}%")

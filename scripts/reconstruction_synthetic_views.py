# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Render a synthetic multi-view capture of an OPM point map with exactly known poses.

Renders the point map as square sprites from eight camera poses on a gentle arc within 1.3 m
of the original viewpoint, all aimed at a point 6 m in front of it, at 1024x768 with a 50
degree vertical field of view, and writes the images together with their intrinsics and
extrinsics. This is the capture that docs/reconstruction-findings.md section 3 runs pycolmap
on and section 4 runs MoGe on. Rendered on 2026-09-02 with the defaults (sprite footprint
0.04 m, 12 px cap, no suffix):

    python scripts/reconstruction_synthetic_views.py <spike_dir>

Caveat that governs every number measured downstream: the renders are pictures of a monocular
point map, not photographs. Texture is exact and the geometry is consistent across views, so
feature matching gets an easier problem than real photographs and accuracy figures measured on
these images are upper bounds.

Frame: +Y up, original camera at the origin looking down -Z.
Renderer camera basis: right, up, fwd (right-handed, fwd = look direction).
COLMAP camera basis: +x right, +y down, +z forward, so R_cw rows = [right, -up, fwd].

Inputs: the spike directory to write into, required; the point map, default
web/packages/app/public/fixtures/memory/glasshouse-courtyard.opm relative to the repository
root. Writes <spike_dir>/images<suffix>/view_NN<suffix>.jpg, PNG previews of views 0 and 4,
and <spike_dir>/ground_truth<suffix>.json. Needs numpy and pillow; the repository's .venv has
both.

Usage:  python scripts/reconstruction_synthetic_views.py <spike_dir> [--opm map.opm]
            [--gain 0.04] [--max-px 12] [--suffix S]
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
DEFAULT_OPM = REPO / 'web/packages/app/public/fixtures/memory/glasshouse-courtyard.opm'

W, H = 1024, 768
FOV_Y_DEG = 50.0
N_VIEWS = 8
LOOK_AT = np.array([0.0, 0.0, -6.0])   # about 6 m in front of the original camera
BG = 246


def parse_args():
    parser = argparse.ArgumentParser(description='Render eight synthetic views of an OPM point map with known poses.')
    parser.add_argument('spike_dir', type=Path, help='directory to write images/ and ground_truth.json into')
    parser.add_argument('--opm', type=Path, default=DEFAULT_OPM, help='.opm point map to render, any version')
    parser.add_argument('--gain', type=float, default=0.04, help='world footprint of a sprite, metres')
    parser.add_argument('--max-px', type=float, default=12.0, help='pixel clamp on the sprite size')
    parser.add_argument('--suffix', default='', help='suffix on the image directory, image names and ground truth')
    return parser.parse_args()


def load(path):
    d = Path(path).read_bytes()
    assert d[:4] == b'OPM1', d[:4]
    n_hdr = int.from_bytes(d[4:8], 'little')
    h = json.loads(d[8:8 + n_hdr])
    pos = next(s for s in h['sections'] if s['name'] == 'position')
    col = next(s for s in h['sections'] if s['name'] == 'color')
    n = h['pointCount']
    p = np.frombuffer(d, np.float32, n * 3, pos['byteOffset']).reshape(-1, 3).astype(np.float64)
    c = np.frombuffer(d, np.uint8, n * 4, col['byteOffset']).reshape(-1, 4)[:, :3].copy()
    return h, p, c


def camera_poses():
    """Camera centres on a gentle arc around the origin, all aimed at LOOK_AT."""
    poses = []
    for i in range(N_VIEWS):
        u = (i / (N_VIEWS - 1)) * 2 - 1          # -1 .. 1
        x = 1.25 * u                              # sideways, +-1.25 m
        z = -0.25 - 0.45 * (1 - u * u)            # slightly forward, 0.25 .. 0.70 m
        y = 0.12 * np.sin(i * 1.3)                # small height variation
        eye = np.array([x, y, z])
        assert np.linalg.norm(eye) <= 1.5, eye
        fwd = LOOK_AT - eye
        fwd /= np.linalg.norm(fwd)
        right = np.cross(fwd, [0.0, 1.0, 0.0])
        right /= np.linalg.norm(right)
        up = np.cross(right, fwd)
        poses.append((eye, right, up, fwd))
    return poses


def render(p, c, eye, right, up, fwd, f, gain, max_px):
    rel = p - eye
    cam = np.stack([rel @ right, rel @ up, rel @ fwd], axis=1)
    keep = cam[:, 2] > 0.1
    cam, cc = cam[keep], c[keep]
    x = cam[:, 0] * f / cam[:, 2] + W / 2
    y = -cam[:, 1] * f / cam[:, 2] + H / 2
    size = np.minimum(gain * f / cam[:, 2], max_px)
    inside = (x > -max_px) & (x < W + max_px) & (y > -max_px) & (y < H + max_px)
    cam, cc, x, y, size = cam[inside], cc[inside], x[inside], y[inside], size[inside]
    canvas = np.full((H, W, 3), BG, np.uint8)
    order = np.argsort(-cam[:, 2])                # painter's order, far to near
    x0 = np.floor(x - size / 2).astype(int)
    x1 = np.ceil(x + size / 2).astype(int)
    y0 = np.floor(y - size / 2).astype(int)
    y1 = np.ceil(y + size / 2).astype(int)
    x0c, x1c = np.clip(x0, 0, W), np.clip(x1, 0, W)
    y0c, y1c = np.clip(y0, 0, H), np.clip(y1, 0, H)
    for i in order:
        if x1c[i] <= x0c[i] or y1c[i] <= y0c[i]:
            continue
        canvas[y0c[i]:y1c[i], x0c[i]:x1c[i]] = cc[i]
    covered = (canvas != BG).any(axis=2).mean()
    return canvas, len(cam), float(covered)


def main():
    args = parse_args()
    out, suffix = args.spike_dir, args.suffix
    images_dir = out / f'images{suffix}'
    images_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    h, p, c = load(args.opm)
    f = (H / 2) / np.tan(np.radians(FOV_Y_DEG) / 2)
    cx, cy = W / 2, H / 2
    gt = {
        'source_opm': str(args.opm.resolve()),
        'point_count': int(h['pointCount']),
        'width': W, 'height': H, 'fov_y_deg': FOV_Y_DEG,
        'fx': f, 'fy': f, 'cx': cx, 'cy': cy,
        'sprite_world_footprint_m': args.gain, 'sprite_max_px': args.max_px,
        'look_at': LOOK_AT.tolist(),
        'convention': {
            'R_wc': 'world-from-camera rotation, columns are camera axes (right, down, forward) expressed in world; COLMAP convention',
            'C': 'camera centre in world metres',
            'cam_from_world': 'x_cam = R_cw x_world + t, R_cw = R_wc^T, t = -R_cw C',
        },
        'views': [],
    }
    for i, (eye, right, up, fwd) in enumerate(camera_poses()):
        t = time.monotonic()
        canvas, n_front, covered = render(p, c, eye, right, up, fwd, f, args.gain, args.max_px)
        name = f'view_{i:02d}{suffix}.jpg'
        img = Image.fromarray(canvas)
        img.save(images_dir / name, quality=92)
        if i == 0 or i == N_VIEWS // 2:
            img.save(out / f'view_{i:02d}{suffix}.png')
        R_wc = np.stack([right, -up, fwd], axis=1)     # columns = camera axes in world (COLMAP: x right, y down, z fwd)
        R_cw = R_wc.T
        t_cw = -R_cw @ eye
        gt['views'].append({
            'name': name,
            'C': eye.tolist(),
            'R_wc': R_wc.tolist(),
            'R_cw': R_cw.tolist(),
            't_cw': t_cw.tolist(),
            'points_in_front': n_front,
            'covered_fraction': covered,
            'render_seconds': time.monotonic() - t,
        })
        print(f'{name}: C={np.round(eye, 3).tolist()} |C|={np.linalg.norm(eye):.3f} m, '
              f'{n_front} pts in front, covered {covered:.3f}, {time.monotonic() - t:.1f}s')
    with open(out / f'ground_truth{suffix}.json', 'w') as fh:
        json.dump(gt, fh, indent=1)
    print(f'f={f:.4f} px, cx={cx}, cy={cy}; total {time.monotonic() - t0:.1f}s')


if __name__ == '__main__':
    main()

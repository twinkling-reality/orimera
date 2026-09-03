# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pycolmap"]
# ///
"""Run pycolmap on a subset of the synthetic views, time each stage and compare to ground truth.

Extracts SIFT features, matches exhaustively and runs incremental mapping on the CPU over
renders in <spike_dir>/images, then aligns the recovered camera centres to
<spike_dir>/ground_truth.json with a similarity (Umeyama) and reports centre and rotation
residuals. Writes <spike_dir>/runs/<tag>/{database.db, sparse/, result.json}, with a text
export of the best model for the pose.py parser check, and prints a one-line brief. The rows
of the table in docs/reconstruction-findings.md section 3 are these runs, summarised by
reconstruction_pycolmap_analyze.py. Measured on 2026-09-02 with pycolmap 4.2.0 on CPU.

Caveat that governs every number: the inputs are renders of a monocular point map, not
photographs. Texture is exact and the geometry is consistent across views, so SIFT gets an
easier problem than real photographs and the accuracy figures are upper bounds; the runtimes,
the API and the file format are real measurements.

Usage:  python scripts/reconstruction_pycolmap_run.py <spike_dir> <config> <n_images | i,j,k> [tri=<deg>] [twoview=1]
  spike_dir: the directory written by reconstruction_synthetic_views.py
  config A: pycolmap defaults (CameraMode.AUTO, SIMPLE_RADIAL, focal prior 1.2*max(w,h))
  config B: CameraMode.SINGLE, PINHOLE, camera_params = known fx,fy,cx,cy (BA still refines focal)
  config C: as B but ba_refine_focal_length = False and abs_pose_refine_focal_length = False
  n_images: the first N views, or a comma-separated list of view indices
  tri=<deg>: override mapper.init_min_tri_angle
  twoview=1: set triangulation.ignore_two_view_tracks = False

The runs behind the table, in an interpreter with pycolmap 4.2.0 and numpy:

    python scripts/reconstruction_pycolmap_run.py <spike_dir> A 8
    python scripts/reconstruction_pycolmap_run.py <spike_dir> B 8
    python scripts/reconstruction_pycolmap_run.py <spike_dir> B 5
    python scripts/reconstruction_pycolmap_run.py <spike_dir> B 3
    python scripts/reconstruction_pycolmap_run.py <spike_dir> A 2
    python scripts/reconstruction_pycolmap_run.py <spike_dir> B 2
    python scripts/reconstruction_pycolmap_run.py <spike_dir> B 2 twoview=1 tri=1
    python scripts/reconstruction_pycolmap_run.py <spike_dir> B 0,7 twoview=1
"""
import json
import shutil
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import pycolmap

USAGE = 'usage: reconstruction_pycolmap_run.py <spike_dir> <A|B|C> <n_images | i,j,k> [tri=<deg>] [twoview=1]'
if len(sys.argv) < 4:
    raise SystemExit(USAGE)
SPIKE = Path(sys.argv[1])
IMAGES = SPIKE / 'images'
with open(SPIKE / 'ground_truth.json') as fh:
    GT = json.load(fh)

config = sys.argv[2]
if ',' in sys.argv[3]:
    indices = [int(i) for i in sys.argv[3].split(',')]
    n_images = len(indices)
    sel = 'v' + '-'.join(map(str, indices))
else:
    n_images = int(sys.argv[3])
    indices = list(range(n_images))
    sel = str(n_images)
extra = dict(a.split('=', 1) for a in sys.argv[4:])
init_min_tri_angle = float(extra['tri']) if 'tri' in extra else None
two_view_tracks = extra.get('twoview') == '1'
tag = (f'{config}{sel}' + (f'_tri{init_min_tri_angle:g}' if init_min_tri_angle is not None else '')
       + ('_twoview' if two_view_tracks else ''))
run_dir = SPIKE / 'runs' / tag
if run_dir.exists():
    shutil.rmtree(run_dir)
run_dir.mkdir(parents=True)
database = run_dir / 'database.db'
sparse = run_dir / 'sparse'
sparse.mkdir()

names = [GT['views'][i]['name'] for i in indices]
result = {'tag': tag, 'config': config, 'n_images': n_images, 'image_names': names,
          'init_min_tri_angle': init_min_tri_angle, 'ignore_two_view_tracks': not two_view_tracks,
          'stages': {}, 'options': {}}


def write_result():
    with open(run_dir / 'result.json', 'w') as out:
        json.dump(result, out, indent=1)


# ---- options -------------------------------------------------------------------------------
reader = pycolmap.ImageReaderOptions()
if config == 'A':
    camera_mode = pycolmap.CameraMode.AUTO
elif config in ('B', 'C'):
    camera_mode = pycolmap.CameraMode.SINGLE
    reader.camera_model = 'PINHOLE'
    reader.camera_params = f"{GT['fx']},{GT['fy']},{GT['cx']},{GT['cy']}"
else:
    raise SystemExit(f'unknown config {config}')
extraction = pycolmap.FeatureExtractionOptions()      # SIFT, use_gpu False, defaults
matching = pycolmap.FeatureMatchingOptions()          # SIFT_BRUTEFORCE, use_gpu False, defaults
pairing = pycolmap.ExhaustivePairingOptions()
verification = pycolmap.TwoViewGeometryOptions()
mapping = pycolmap.IncrementalPipelineOptions()
if init_min_tri_angle is not None:
    mapping.mapper.init_min_tri_angle = init_min_tri_angle
if two_view_tracks:
    mapping.triangulation.ignore_two_view_tracks = False
if config == 'C':
    mapping.ba_refine_focal_length = False
    mapping.mapper.abs_pose_refine_focal_length = False
result['options'] = {
    'camera_mode': str(camera_mode),
    'reader': {'camera_model': reader.camera_model, 'camera_params': reader.camera_params,
               'default_focal_length_factor': reader.default_focal_length_factor},
    'device': 'Device.cpu',
    'extraction': extraction.summary(),
    'matching': matching.summary(),
    'pairing': pairing.summary(),
    'verification': verification.summary(),
    'mapping': mapping.summary(),
}


# ---- stages ----------------------------------------------------------------------------------
def timed(stage, fn):
    t = time.monotonic()
    try:
        out = fn()
        result['stages'][stage] = {'seconds': time.monotonic() - t, 'ok': True}
        return out
    except Exception as exc:
        result['stages'][stage] = {'seconds': time.monotonic() - t, 'ok': False,
                                   'error': repr(exc), 'traceback': traceback.format_exc()}
        raise


try:
    timed('extract_features', lambda: pycolmap.extract_features(
        database, IMAGES, image_names=names, camera_mode=camera_mode, reader_options=reader,
        extraction_options=extraction, device=pycolmap.Device.cpu))
    db = pycolmap.Database.open(str(database))
    result['database'] = {'num_images': db.num_images(), "num_cameras": db.num_cameras(),
                          "num_keypoints": db.num_keypoints()}
    db.close()

    timed('match_exhaustive', lambda: pycolmap.match_exhaustive(
        database, matching_options=matching, pairing_options=pairing,
        verification_options=verification, device=pycolmap.Device.cpu))
    db = pycolmap.Database.open(str(database))
    result['database'].update({'num_matched_pairs': db.num_matched_image_pairs(),
                               'num_verified_pairs': db.num_verified_image_pairs(),
                               'num_matches': db.num_matches(),
                               'num_inlier_matches': db.num_inlier_matches()})
    db.close()

    maps = timed('incremental_mapping', lambda: pycolmap.incremental_mapping(
        database, IMAGES, sparse, options=mapping))
except Exception:
    result['failed'] = True
    write_result()
    print(json.dumps({k: result[k] for k in ('tag', 'stages')}))
    raise

result['model_count'] = len(maps)
result['models'] = []
for idx, rec in sorted(maps.items()):
    result['models'].append({
        'index': idx,
        'num_reg_images': rec.num_reg_images(),
        'num_points3D': rec.num_points3D(),
        'num_cameras': rec.num_cameras(),
        'mean_reprojection_error_px': rec.compute_mean_reprojection_error(),
        'mean_track_length': rec.compute_mean_track_length(),
        'mean_obs_per_reg_image': rec.compute_mean_observations_per_reg_image(),
        'summary': rec.summary(),
    })

if maps:
    best_idx = max(maps, key=lambda i: maps[i].num_reg_images())
    rec = maps[best_idx]
    result['best_model'] = best_idx
    # text export for the parser comparison
    text_dir = sparse / f'{best_idx}_text'
    text_dir.mkdir()
    rec.write_text(str(text_dir))
    result['text_export'] = str(text_dir)
    # mean error by iterating points3D, as a cross-check of compute_mean_reprojection_error
    errs = [p.error for p in rec.points3D.values() if p.has_error()]
    result['mean_error_from_points3D'] = float(np.mean(errs)) if errs else None
    result['cameras'] = {}
    for cid, cam in rec.cameras.items():
        result['cameras'][int(cid)] = {'model': cam.model_name if hasattr(cam, 'model_name') else str(cam.model),
                                       'params': list(map(float, cam.params)),
                                       'focal_length': float(cam.mean_focal_length()),
                                       'has_prior_focal_length': bool(cam.has_prior_focal_length)}

    # ---- ground truth comparison ---------------------------------------------------------
    gt_by_name = {v['name']: v for v in GT['views']}
    est_C, gt_C, est_Rwc, gt_Rwc, reg_names = [], [], [], [], []
    for img in rec.images.values():
        if not img.has_pose:
            continue
        pose = img.cam_from_world
        if callable(pose):
            pose = pose()
        R_cw = np.asarray(pose.rotation.matrix())
        C = np.asarray(img.projection_center())
        est_C.append(C)
        est_Rwc.append(R_cw.T)
        gt_C.append(np.array(gt_by_name[img.name]['C']))
        gt_Rwc.append(np.array(gt_by_name[img.name]['R_wc']))
        reg_names.append(img.name)
    result['registered_names'] = reg_names
    est_C, gt_C = np.array(est_C), np.array(gt_C)

    def umeyama(src, dst):
        """Return s, R, t with dst ~= s * R @ src + t."""
        n = src.shape[0]
        mu_s, mu_d = src.mean(0), dst.mean(0)
        xs, xd = src - mu_s, dst - mu_d
        cov = xd.T @ xs / n
        U, D, Vt = np.linalg.svd(cov)
        S = np.eye(3)
        if np.linalg.det(U) * np.linalg.det(Vt) < 0:
            S[2, 2] = -1
        R = U @ S @ Vt
        var_s = (xs ** 2).sum() / n
        s = np.trace(np.diag(D) @ S) / var_s
        t = mu_d - s * R @ mu_s
        return s, R, t

    if len(est_C) >= 3:
        s, R, t = umeyama(est_C, gt_C)
        aligned = (s * (R @ est_C.T)).T + t
        resid = np.linalg.norm(aligned - gt_C, axis=1)
        rot_err = []
        for Rwc_e, Rwc_g in zip(est_Rwc, gt_Rwc, strict=True):
            Rp = R @ Rwc_e
            cosang = np.clip((np.trace(Rwc_g.T @ Rp) - 1) / 2, -1, 1)
            rot_err.append(float(np.degrees(np.arccos(cosang))))
        result['alignment'] = {
            'method': 'Umeyama with scale on camera centres, gt ~= s R est + t',
            'n_cameras': len(est_C),
            'scale_metres_per_colmap_unit': float(s),
            'rms_centre_residual_m': float(np.sqrt((resid ** 2).mean())),
            'max_centre_residual_m': float(resid.max()),
            'per_image_centre_residual_m': dict(zip(reg_names, map(float, resid), strict=True)),
            'mean_rotation_error_deg': float(np.mean(rot_err)),
            'max_rotation_error_deg': float(np.max(rot_err)),
            'per_image_rotation_error_deg': dict(zip(reg_names, rot_err, strict=True)),
            'gt_baseline_extent_m': float(max(np.linalg.norm(a - b) for a in gt_C for b in gt_C)),
            'est_baseline_extent_units': float(max(np.linalg.norm(a - b) for a in est_C for b in est_C)),
        }
    elif len(est_C) == 2:
        # a similarity is under-determined by two centres; report scale from the one baseline and
        # the relative rotation error, which does not need the alignment
        d_est = np.linalg.norm(est_C[0] - est_C[1])
        d_gt = np.linalg.norm(gt_C[0] - gt_C[1])
        R_rel_est = est_Rwc[0].T @ est_Rwc[1]
        R_rel_gt = gt_Rwc[0].T @ gt_Rwc[1]
        cosang = np.clip((np.trace(R_rel_gt.T @ R_rel_est) - 1) / 2, -1, 1)
        # direction of the baseline expressed in camera 0: compare directly (scale-free)
        b_est = est_Rwc[0].T @ (est_C[1] - est_C[0]) / d_est
        b_gt = gt_Rwc[0].T @ (gt_C[1] - gt_C[0]) / d_gt
        result['alignment'] = {
            'method': 'two cameras: scale from the single baseline; relative rotation and baseline direction errors in camera 0 frame',
            'n_cameras': 2,
            'scale_metres_per_colmap_unit': float(d_gt / d_est),
            'relative_rotation_error_deg': float(np.degrees(np.arccos(cosang))),
            'baseline_direction_error_deg': float(np.degrees(np.arccos(np.clip(b_est @ b_gt, -1, 1)))),
            'gt_baseline_m': float(d_gt),
        }
    else:
        result['alignment'] = {'n_cameras': len(est_C), 'note': 'fewer than two registered cameras'}

write_result()
brief = {k: result.get(k) for k in ('tag', 'model_count')}
brief['stages'] = {k: round(v['seconds'], 2) for k, v in result['stages'].items()}
brief['models'] = [(m['num_reg_images'], m['num_points3D'], round(m['mean_reprojection_error_px'], 3)) for m in result.get('models', [])]
brief['alignment'] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in result.get('alignment', {}).items() if not k.startswith('per_image')}
print(json.dumps(brief))

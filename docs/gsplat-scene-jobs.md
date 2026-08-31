# Per-scene gsplat jobs

Status: **controller and gate implemented; resumable trainer image and real scene blocked**.

`orimera.reconstruction.splat` is the content-addressed controller for one scene-specific Gaussian
splat optimization. The manifest pins the exact source set, accepted pose-manifest digest, Orimera
revision, gsplat revision, digest-pinned execution image, requested GPU, dependency inventory,
MCMC parameters, checkpoint interval, iteration and Gaussian caps, held-out policy, price rate, and
reviewed quality thresholds.

Before any GPU command starts, the controller independently verifies the pose receipt digest, its
accepted quality result, a positive measured metric scale, and (for joint capture sets) the shared
metric-frame gate. A pose digest written into a manifest is not accepted on assertion alone.

The dependency inventory must contain `gsplat` and rejects the common INRIA
`diff-gaussian-rasterization` and `gaussian-splatting` package names. The runtime receipt is checked
again after execution and must say backend `gsplat`, the exact pinned revision, and every loaded
package. This is a hard refusal, not a license warning.

The controller invokes a reviewed `orimera-gsplat-scene-v1` container entrypoint with `--resume
auto`. Exit 75 is a preemption only when a durable checkpoint exists; it is distinct from failure.
Actual iteration count, duration, GPU, CUDA, driver, peak VRAM, and loaded packages come back from
the runtime, not from requested values. Cost is the actual duration multiplied by the manifest's
versioned hourly rate.

The quality receipt must contain a real held-out count, PSNR, SSIM, LPIPS, floater fraction, and
coverage fraction. Missing or non-finite values are refused. A scene failing any explicit threshold
keeps rung 3 and is not compressed. An accepted PLY is converted with the documented PlayCanvas CLI
shape `splat-transform --no-tty --overwrite -g cpu input.ply output.sog`; the SOG byte size and
SHA-256 digest enter the receipt. Checkpoints and training state are excluded from package output by
default.

The upstream gsplat `simple_trainer.py` is Apache-2.0 and provides MCMC, held-out metrics, PLY, and
checkpoints, but its current `--ckpt` mode explicitly skips training and evaluates only. It is not a
resumable trainer and is not silently presented as one. A reviewed digest-pinned runner that saves
and restores optimizer, densification strategy, random state, and iteration state is therefore a
named external implementation blocker. Sources inspected 2026-08-31:

- <https://github.com/nerfstudio-project/gsplat/blob/main/examples/simple_trainer.py>
- <https://github.com/nerfstudio-project/gsplat/blob/main/examples/benchmarks/mcmc.sh>
- <https://github.com/playcanvas/splat-transform>

No authorized dense capture, compatible GPU, pinned runner image, or real held-out result exists
locally. Phase 3C has not passed its roadmap gate and no rung-1 scene is claimed.

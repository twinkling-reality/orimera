# COLMAP pose jobs

Status: **production worker integrated and contract-tested; no authorized real dense capture run**.

`orimera.reconstruction.pose` runs COLMAP feature extraction, exhaustive matching, and sparse
mapping from an exact authorized source manifest. The manifest pins every staged filename and byte
digest, an exact Git revision, exact COLMAP version, digest-pinned execution image, explicit reviewed
quality thresholds, capture-set membership, and an optional measured scale with its method. Original
paths, media bytes, semantic labels, and inferred consent are absent.

Each manifest has one content-addressed job directory outside Git. A filesystem lock serializes
claimants. Every subprocess result records the exact argument vector, actual duration, return code,
and stdout/stderr digests. A checkpoint is fsynced after feature extraction, matching, mapping, and
each binary-to-text model conversion.
Restart skips only completed stages whose required durable outputs still exist. A completed receipt
is reused only after the current sparse artifacts reproduce its quality digest.

`run_scene_grouping` now queues exact sets selected by the recorded
`orimera.scene-group-pose-selection/v1` policy, and `orimera-scene-worker` runs this controller in a
separate process with a renewable database lease. The accepted receipt is stored as a scene
artifact, not left in the job directory. The worker atomically commits the completed scene,
registration outcomes, pose, placement and gate artifacts, the rung assertion, and terminal job
state. See [scene-reconstruction-operations.md](scene-reconstruction-operations.md) for the full
production and deletion contract.

The parser reads registered image names and camera centres from COLMAP `images.txt`, and actual
reprojection errors from `points3D.txt`. It reports registration fraction, mean reprojection error,
camera-translation extent, all output digests and sizes, the selected connected model, and every
fallback reason. The largest connected model is selected deterministically by registered image
count and path; a place name never participates.

Multiple capture sets are co-registered only when registered images from every declared set occur
in that one connected model. That still does not make the result metric: a shared metric frame also
requires an explicit positive measured scale and method. Failure, low coverage, poor reprojection,
insufficient translation, disconnection, or missing scale retains rung 3 with the recorded reason.

Sensitive staged images, COLMAP databases, descriptors and sparse working files are separate from
the durable receipt. They are removed after success, handled failure, or cancellation. A process
crash retains only restartable scratch until lease reclaim or the age-gated startup sweep. A crash
on the final claim is terminalized before that sweep, so no expired job remains permanently
`running`.

No consented dense OGC-1 capture group or digest-pinned production runtime was available for this
work, so Phase 3B has not passed its representative real-corpus quality gate. The production path
exists and is tested with deterministic executors, but no real pose quality result is claimed.

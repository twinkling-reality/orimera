# Production reconstruction scenes

Status: **IMPLEMENTED and PostgreSQL-tested 2026-09-04; no authorized real capture run**.

This document is the operating contract for Orimera's production rung-3 multi-photograph path.
It covers scene selection, durable work, pose recovery, placement, graph delivery, rendering,
deletion, and recovery. It does not claim that the path has passed a representative real-corpus
quality gate. No consented dense capture set or digest-pinned production pose image was available
for that measurement.

## 1. Production flow

The normal ingest flow runs scene grouping after capture processing. `run_scene_grouping` records
the groups, applies `SceneGroupPosePolicy`, and enqueues each selected exact member set. The
initial policy is deliberately narrow and versioned as
`orimera.scene-group-pose-selection/v1`:

- it considers the deterministic presentation order already produced by `scene_group` version 1;
- it selects groups with at least three members because the current sparse backend discards
  two-view tracks; and
- it records that the policy has not been validated against a representative photograph corpus
  and does not predict registration or quality.

The grouping stage's current one-hour and 250-metre boundaries are unvalidated stage parameters.
They are not hidden product rules. Changing them changes the stage digest and therefore creates a
new deterministic grouping result. A future reviewed selection policy can replace
`SceneGroupPosePolicy` without changing scene identity, job leasing, placement, or delivery.

The queue row is durable before compute starts. It owns an immutable ordered membership table, the
complete member-set digest, the selection-policy digest, a deterministic job id, and the
deterministic `reconstruction_scene` id. Registration is not part of either identity. The completed
scene and all registration outcomes are inserted only after pose recovery, and all membership rows
are inserted in the same database transaction.

The separate `orimera-scene-worker` process then performs this sequence:

1. Claim the next eligible exact set with `FOR UPDATE SKIP LOCKED` and a renewable lease.
2. Stage only the declared source blobs under the job's canonical workspace/job scratch key,
   verifying every byte digest and refusing undeclared files.
3. Run checkpointed pycolmap feature extraction, matching, sparse mapping, and model conversion.
4. Persist a pose receipt, point-map placement record, and scene-gate decision in the
   content-addressed store.
5. In one transaction, insert the completed scene and registration outcomes, insert or verify all
   three artifact rows, record the scene-rung assertion, and mark the job succeeded.
6. Remove the sensitive scratch directory after success, handled failure, or cancellation.

If that acceptance transaction loses its lease, observes deletion, or disagrees with existing
bytes, none of the scene rows, artifact rows, assertion, or successful job transition commits.

## 2. Durable artifact chain

The accepted chain has three independently versioned records:

| Record | Current profile | What it binds |
| --- | --- | --- |
| Pose receipt | `orimera.colmap-pose-receipt/v2` | exact source manifest, source digests, code revision, pycolmap version, runtime image digest, commands, sparse outputs, recovered cameras, registration and quality |
| Placement | `orimera.posed-point-map-placement/v1` | scene id, complete ordered member set, pose receipt digest, pose manifest digest, each current point-map artifact id and content digest, transform, scale status, and every exclusion |
| Gate | `orimera.reconstruction-scene-gate/v1` | every receipt digest it read, complete and registered counts, awarded rung, and all withholding reasons |

Artifact ids are deterministic functions of the scene, stage version and parameters, and exact
input digests. A retry may reproduce and verify the same row. It cannot create a second conflicting
truth for the same input key.

The placement validator refuses unsupported versions, missing or duplicate members, outcomes that
do not cover the exact member set, point maps from outside the scene, unknown or changed artifact
rows, content-digest disagreement, pose-member disagreement, non-finite transforms, non-affine
matrices, non-orthonormal rotations, reflections, and non-positive scales. It rebuilds the expected
record from the current pose receipt and point-map inputs and requires exact equality.

## 3. Coordinate and scale convention

OPM/2 remains a per-photograph artifact in its source-camera frame. Placement never changes its
bytes.

COLMAP reports `camera_from_world` with camera axes +X right, +Y down, +Z forward. OPM uses +X
right, +Y up, -Z forward. The placement producer first applies `diag(1, -1, -1)` to map OPM axes
into COLMAP camera axes, then applies the inverse recovered camera pose. The stored transform is a
row-major 4 by 4 `scene_from_opm` matrix.

COLMAP world units are scale ambiguous. Version 1 records `local_units_to_scene_units = 1.0` and
`scale_status = unvalidated-identity` for display only. It explicitly says the result is not metric.
No query, corridor, navigation, or rung gate may treat those units as metres.

## 4. Graph delivery and rendering

`GET /graph` reads graph state and reconstruction scenes inside one repeatable-read, read-only
transaction. Each `reconstruction_scenes` entry carries one authoritative scene description:

- ordered registered and unregistered members;
- pose, placement, and gate digests;
- recorded rung and recorded withholding reasons from the assertion;
- displayed rung and display reasons;
- current rendering substrate;
- each registered member's validated point-map descriptor and transform; and
- an explicit exclusion reason for every member without a placement.

Before exposing any transform, the server retrieves and digest-checks the three durable records,
reproduces the gate decision, validates the placement against the immutable scene members, and
requires each placed point map to match its exact live artifact row. Missing or invalid scene
receipts preserve the recorded assertion for explanation but switch delivery to source photographs.

The browser fetches every available placed map with its workspace bearer, verifies the declared
SHA-256 before decoding OPM/2, validates the matrix, and creates one scene root with one transformed
point-cloud child per accepted member. Residency cost, footprint, arrival framing, and camera
coverage include all loaded children. A corrupt or missing member degrades independently, while
the member's source photograph remains available through the ordinary source-first region.

Captures that have ever belonged to a reconstruction scene are omitted from the legacy unposed
`GET /geometry` list. This prevents deletion or a broken scene receipt from silently putting a
surviving member back at an invented island origin. Exact bytes for a live point-map artifact remain
available when another validated scene refers to them.

## 5. Recorded rung, displayed rung, and substrate

These are separate facts:

- `recorded_rung` is the durable scene assertion produced by the scene gate;
- `displayed_rung` is the worst-first mode this client can honestly show now; and
- `rendering_substrate` is either `posed_point_maps` or `source_photographs` in this client.

Decoded geometry never promotes `recorded_rung`. With the current unmeasured thresholds, a scene
with at least one registered and placed point map records rung 3. The gate also records why rung 1
has no reviewed splat receipt and why rung 2 lacks physically validated scale, measured coverage,
and a measured corridor. If no verified placed bytes are available, the client displays rung 4
source photographs while retaining the recorded rung and reasons in the disclosure. If a future
assertion records rung 1 or 2 before this client supports that substrate, the displayed rung stays
3 and the disclosure says why.

The status disclosure is the authoritative render site for rung copy. It names the recorded scene
rung, displayed rung, substrate, registered count, and all gate or fallback reasons.

## 6. Deletion and scratch lifecycle

A tombstone for any scene or queued-job member, including an unregistered member, does all of the
following:

- cancels a queued, failed, or running scene job in the database;
- makes the running worker's cancellation check stop pycolmap;
- blocks completed scene assertions and artifacts immediately;
- removes the scene from graph delivery and World Memory Package projection; and
- makes scene artifact bytes eligible for the separately authorized purge flow.

COLMAP databases, feature descriptors, staged sources, and sparse working files live only under
`ORIMERA_DATA_DIR/reconstruction-scratch/<workspace>/<job>`. Durable receipts live in the
content-addressed store, outside scratch. The worker holds a non-blocking filesystem lock for the
whole sensitive lifetime. Cleanup accepts only canonical UUID path pairs, refuses symbolic links,
skips a locked directory, and never deletes scratch protected by queued, running, or retryable work.

A process crash leaves its checkpointed scratch in place. After lease expiry, another worker
reclaims the same job and the pose controller skips only checkpoints whose required outputs still
verify. A startup sweep removes old unprotected scratch. If a process dies on the final allowed
claim, startup first changes the expired job to terminal `failed` with
`failure_class = claim_exhausted`, then makes its old scratch eligible for that sweep. A retry after
handled cleanup safely restages the exact source set.

## 7. Running the worker

The production image includes the pinned `pycolmap==4.2.0` pose extra. For a local source checkout,
install or invoke that extra explicitly.

```bash
export ORIMERA_DATABASE_URL=postgresql://orimera_app:<password>@localhost:5433/orimera
export ORIMERA_DATA_DIR=.orimera/local
export ORIMERA_WORKSPACE_IDS=<workspace-uuid>[,<workspace-uuid>...]
export ORIMERA_CODE_REVISION=<exact-40-character-git-revision>
export ORIMERA_POSE_RUNTIME_IMAGE=<registry/image@sha256:digest>
uv run --extra pose orimera-scene-worker
```

Both provenance variables are required. A mutable image tag or guessed checkout is not accepted.
The worker also refuses an owner, superuser, or BYPASSRLS database role and an empty workspace set.
Use `--once` to drain the work currently eligible and exit. Defaults are a 900-second lease,
30-second heartbeat, 2-second polling interval, and 3600-second abandoned-scratch age.

## 8. Known blockers

Rung 2 is not implemented by this path. It requires a physically validated scale receipt, measured
coverage, a measured collision-safe corridor, required destinations, and structural-world
authority. Rung 1 is not implemented by this path. It requires a reviewed resumable gsplat runner,
compatible GPU execution, physically validated scale, measured coverage, and real held-out quality
results.

Those producers are additive inputs to the scene gate. They do not change scene identity, member
registration, OPM/2, the placement record, deletion reachability, or the graph's distinction among
recorded rung, displayed rung, and substrate.

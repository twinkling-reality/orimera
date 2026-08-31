# Physical residency and renderer hardening

Status: **RENDERER CONTRACT IMPLEMENTED; production asset publication and target-hardware gate
BLOCKED**. The repository has no authorised real reconstruction asset, authenticated world-asset
route, target-hardware trace, or deployed object-store response to measure. This document does not
turn predecoded fixture maps or mocked HTTP responses into a production streaming claim.

## Physical residency executor

`web/packages/atlas-react/src/playcanvas/physical-residency.ts` consumes the existing logical
`load`, `cancel`, and `release` actions. A load has four ordered phases: authenticated fetch, decode,
GPU upload, then publication. Each island carries a monotonic generation. Generation is checked
after every asynchronous boundary and immediately before publication, so a fetch that ignores its
abort signal is disposed as stale and cannot become current.

The published asset descriptor distinguishes `missing`, `unavailable`, `unsupported`, and
`deleted`. Those states settle the logical request as a fallback without invoking fetch. A resource
replacement publishes the checked new resource before disposing the prior one. Release and runtime
destruction unpublish and dispose decoded and uploaded resources. Context loss retains decoded CPU
state, disposes GPU state, and attempts re-upload; a failed restore invokes the complete World Index
recovery callback.

The executor accepts only local authenticated API paths. `fetchAuthenticatedAsset` places the
bearer in the request header, never the path, verifies an expected SHA-256 when supplied, and records
whether a requested byte range returned an observed `206` plus `Content-Range` or was ignored with a
whole-object `200`. Tests exercise both outcomes. This is instrumentation of the real response, not
evidence that the currently absent production asset route honors Range usefully.

`AtlasBinding.onResidencyActions` is now the production seam. With no executor, already decoded
fixture maps settle immediately. With an executor installed, a visual stays at its current physical
stage until `settleResidencyRequest` acknowledges checked publication. Planned allocation no longer
enables a not-yet-uploaded visual.

## Measurement-driven downgrade

`RepresentationPressureController` observes rolling p95 frame time and, when available, resident
bytes divided by a declared budget. Two overloaded windows lower the maximum physical stage and
the residency budget; five healthy windows restore one level. It receives no device name, user
agent, GPU model, display class, or hardware allowlist. Hidden-tab and non-positive frame samples do
not influence the renderer. The binding replans only when the measured pressure level changes.

## Precision and scale

Canonical Atlas coordinates remain unchanged. `renderOriginForNeighborhood` chooses a stable,
quantized GPU origin from the active durable neighborhood. PlayCanvas shifts one render root and
the camera by that origin; overlays and procedural field coordinates apply the inverse translation.
Placement verification adds the render origin back before comparing with canonical `localToAtlas`,
so rebasing cannot hide a transform error.

The world field no longer truncates presentation buffers at five regions and ten traces. Shader
capacity and typed buffers are generated from the exact topology counts, and a 120-region contract
test verifies that every region reaches the buffer. No additional draw batching is claimed: there
is no target-hardware measurement in this checkout demonstrating a draw-call bottleneck or a safe
batch size.

## Context recovery and remaining gate

The application shell has an unconditional `show-index` transition. A WebGL context-loss event
prevents the browser default, opens the complete World Index, and reports why the 3D surface is no
longer current. The physical executor separately tests retained-decode re-upload and its World Index
failure callback.

Unit and integration contracts now cover stale/cancelled fetches, honest availability states,
fetch/decode/upload ordering, downgrade/release/disposal, context restore failure, Range response
classification, pressure downgrade/recovery, neighborhood rebasing, scalable field buffers, and
the Index recovery transition.

The Phase 6 exit gate still requires published real assets and a large fixed topology on declared
target hardware and network budgets. It also requires an actual authenticated origin/CDN trace to
answer whether ranges are useful. Those inputs do not exist locally, so the renderer contract can
be committed while the experiential/operational phase gate remains blocked.

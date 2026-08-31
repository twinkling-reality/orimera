# Reconstruction quality gate

Status: **implemented measurement contract; real gate blocked**.

`orimera.reconstruction.validate_opm` now validates every production point map before it is
persisted. The PlayCanvas reader independently validates its untrusted byte boundary before it
constructs typed-array views. Both sides check the format, version, rung, explicit metric flag,
camera axes, source dimensions and aspect, field of view, bounds, section types, exact lengths,
alignment, and container range. The production validator additionally checks every position is
finite, in front of the source camera, and agrees with the declared bounds, and that every point
uses a declared segment.

The renderer exposes a source-panel envelope derived from the artifact's measured depth bounds and
source-camera frustum. That envelope is an observed presentation extent only. It is not navigation,
collision, an Atlas-space scale, or permission to move away from the source viewpoint.

`orimera.reconstruction.quality` is the versioned report contract for the remaining real checks:

- structural OPM integrity;
- PlayCanvas consumption and actual load duration;
- authorized source opening and evidence linkage;
- visual alignment from the exact source-camera pose;
- metric versus non-metric behavior;
- deletion closure;
- production duration, byte size, and returned cost; and
- the valid-fraction distribution used to review the rung-3 threshold.

Missing values remain absent and block the gate. Synthetic or development observations can test the
contract but can never pass the real-corpus gate. The existing `min_valid_fraction_milli = 150`
stage parameter remains explicitly unvalidated and unchanged.

No consented OGC-1 corpus, signed consent record, or real quality observations were found locally on
2026-08-31. Therefore Phase 3A has a productionized contract but has **not** passed its roadmap gate.

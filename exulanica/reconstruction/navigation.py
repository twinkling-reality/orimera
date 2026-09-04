"""Version-bound rung-2 corridor artifacts derived from measured camera poses.

Navigation is not inferred from splat pixels.  A reviewed reconstruction/navigation tool supplies
metric pose samples with independently measured clearance and slope.  This module turns those
facts into a deterministic centreline, lateral envelope, look envelope, destinations, and recovery
poses, bound to exact reconstruction and topology digests.  Any incomplete check retains rung 3.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Literal

__all__ = [
    "CorridorArtifact",
    "CorridorBuildManifest",
    "Destination",
    "NavigationPoseSample",
    "build_corridor_artifact",
    "validate_corridor_artifact",
]


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _sha(value: str, field: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"{field} must be lowercase SHA-256 hex")


def _vector(value: tuple[float, float, float], field: str) -> None:
    if len(value) != 3 or not all(math.isfinite(item) for item in value):
        raise ValueError(f"{field} must contain three finite values")


@dataclass(frozen=True, slots=True)
class NavigationPoseSample:
    camera_ref: str
    position_metres: tuple[float, float, float]
    forward: tuple[float, float, float]
    clearance_radius_metres: float
    slope_degrees: float
    source_vantage: bool = False
    recovery_pose: bool = False

    def __post_init__(self) -> None:
        if not self.camera_ref:
            raise ValueError("camera_ref is required")
        _vector(self.position_metres, "position_metres")
        _vector(self.forward, "forward")
        length = math.sqrt(sum(item * item for item in self.forward))
        if not math.isclose(length, 1, rel_tol=1e-5, abs_tol=1e-7):
            raise ValueError("forward must be a measured unit vector")
        if self.clearance_radius_metres < 0 or not math.isfinite(
            self.clearance_radius_metres
        ):
            raise ValueError("clearance radius must be finite and non-negative")
        if not 0 <= self.slope_degrees <= 180 or not math.isfinite(self.slope_degrees):
            raise ValueError("slope must be finite and between zero and 180 degrees")


@dataclass(frozen=True, slots=True)
class Destination:
    destination_ref: str
    camera_ref: str

    def __post_init__(self) -> None:
        if not self.destination_ref or not self.camera_ref:
            raise ValueError("destination_ref and camera_ref are required")


@dataclass(frozen=True, slots=True)
class CorridorBuildManifest:
    scene_ref: str
    reconstruction_digest: str
    topology_digest: str
    samples: tuple[NavigationPoseSample, ...]
    required_destinations: tuple[Destination, ...]
    agent_radius_metres: float
    maximum_lateral_metres: float
    maximum_pose_gap_metres: float
    maximum_slope_degrees: float
    maximum_look_yaw_degrees: float
    minimum_look_pitch_degrees: float
    maximum_look_pitch_degrees: float

    def __post_init__(self) -> None:
        if not self.scene_ref:
            raise ValueError("scene_ref is required")
        _sha(self.reconstruction_digest, "reconstruction_digest")
        _sha(self.topology_digest, "topology_digest")
        if len(self.samples) < 2:
            raise ValueError("a corridor requires at least two measured poses")
        if len({item.camera_ref for item in self.samples}) != len(self.samples):
            raise ValueError("camera references must be unique")
        if len({item.destination_ref for item in self.required_destinations}) != len(
            self.required_destinations
        ):
            raise ValueError("destination references must be unique")
        for field in (
            "agent_radius_metres",
            "maximum_lateral_metres",
            "maximum_pose_gap_metres",
            "maximum_slope_degrees",
            "maximum_look_yaw_degrees",
        ):
            value = getattr(self, field)
            if value <= 0 or not math.isfinite(value):
                raise ValueError(f"{field} must be finite and positive")
        if not -89 <= self.minimum_look_pitch_degrees <= self.maximum_look_pitch_degrees <= 89:
            raise ValueError("look pitch bounds must be ordered within [-89, 89]")
        if not 0 < self.maximum_look_yaw_degrees <= 180:
            raise ValueError("maximum look yaw must be within (0, 180]")

    def as_payload(self) -> dict[str, object]:
        return {
            "profile": "exulanica.corridor-build/v1",
            "scene_ref": self.scene_ref,
            "reconstruction_digest": self.reconstruction_digest,
            "topology_digest": self.topology_digest,
            "samples": [
                {
                    "camera_ref": item.camera_ref,
                    "position_metres": list(item.position_metres),
                    "forward": list(item.forward),
                    "clearance_radius_metres": item.clearance_radius_metres,
                    "slope_degrees": item.slope_degrees,
                    "source_vantage": item.source_vantage,
                    "recovery_pose": item.recovery_pose,
                }
                for item in self.samples
            ],
            "required_destinations": [
                {
                    "destination_ref": item.destination_ref,
                    "camera_ref": item.camera_ref,
                }
                for item in self.required_destinations
            ],
            "agent_radius_metres": self.agent_radius_metres,
            "maximum_lateral_metres": self.maximum_lateral_metres,
            "maximum_pose_gap_metres": self.maximum_pose_gap_metres,
            "maximum_slope_degrees": self.maximum_slope_degrees,
            "look_envelope_degrees": {
                "maximum_yaw": self.maximum_look_yaw_degrees,
                "minimum_pitch": self.minimum_look_pitch_degrees,
                "maximum_pitch": self.maximum_look_pitch_degrees,
            },
        }

    @property
    def digest(self) -> str:
        return _digest(self.as_payload())


@dataclass(frozen=True, slots=True)
class CorridorArtifact:
    manifest_digest: str
    reconstruction_digest: str
    topology_digest: str
    centreline: tuple[tuple[float, float, float], ...]
    lateral_half_widths: tuple[float, ...]
    collision_clearance_radii: tuple[float, ...]
    surface_slope_degrees: tuple[float, ...]
    agent_radius_metres: float
    forwards: tuple[tuple[float, float, float], ...]
    maximum_look_yaw_degrees: float
    minimum_look_pitch_degrees: float
    maximum_look_pitch_degrees: float
    required_destinations: tuple[tuple[str, int], ...]
    source_vantage_indices: tuple[int, ...]
    recovery_pose_indices: tuple[int, ...]
    accepted: bool
    published_rung: Literal[2, 3]
    reasons: tuple[str, ...]
    sha256: str

    def unsigned_payload(self) -> dict[str, object]:
        return {
            "profile": "exulanica.corridor-artifact/v1",
            "manifest_digest": self.manifest_digest,
            "reconstruction_digest": self.reconstruction_digest,
            "topology_digest": self.topology_digest,
            "centreline": [list(item) for item in self.centreline],
            "lateral_half_widths": list(self.lateral_half_widths),
            "collision_proxy": {
                "clearance_radii_metres": list(self.collision_clearance_radii),
                "agent_radius_metres": self.agent_radius_metres,
            },
            "navigation_surface": {
                "slope_degrees": list(self.surface_slope_degrees),
            },
            "forwards": [list(item) for item in self.forwards],
            "look_envelope_degrees": {
                "maximum_yaw": self.maximum_look_yaw_degrees,
                "minimum_pitch": self.minimum_look_pitch_degrees,
                "maximum_pitch": self.maximum_look_pitch_degrees,
            },
            "required_destinations": [
                {"destination_ref": name, "centreline_index": index}
                for name, index in self.required_destinations
            ],
            "source_vantage_indices": list(self.source_vantage_indices),
            "recovery_pose_indices": list(self.recovery_pose_indices),
            "accepted": self.accepted,
            "published_rung": self.published_rung,
            "reasons": list(self.reasons),
        }

    def as_payload(self) -> dict[str, object]:
        return {**self.unsigned_payload(), "sha256": self.sha256}


def build_corridor_artifact(manifest: CorridorBuildManifest) -> CorridorArtifact:
    """Build a conservative corridor; every failure publishes rung 3, never a wider path."""
    reasons: list[str] = []
    index_by_camera = {item.camera_ref: index for index, item in enumerate(manifest.samples)}
    destinations: list[tuple[str, int]] = []
    for destination in manifest.required_destinations:
        index = index_by_camera.get(destination.camera_ref)
        if index is None:
            reasons.append(f"destination {destination.destination_ref} has no measured pose")
        else:
            destinations.append((destination.destination_ref, index))

    widths: list[float] = []
    for sample in manifest.samples:
        width = min(
            manifest.maximum_lateral_metres,
            sample.clearance_radius_metres - manifest.agent_radius_metres,
        )
        widths.append(max(0.0, width))
        if width < 0:
            reasons.append(f"{sample.camera_ref} has insufficient clearance for the agent radius")
        if sample.slope_degrees > manifest.maximum_slope_degrees:
            reasons.append(f"{sample.camera_ref} exceeds the maximum slope")

    for left, right in zip(manifest.samples, manifest.samples[1:], strict=False):
        distance = math.dist(left.position_metres, right.position_metres)
        if distance > manifest.maximum_pose_gap_metres:
            reasons.append(f"camera gap {left.camera_ref} to {right.camera_ref} is not traversable")

    source_indices = tuple(
        index for index, item in enumerate(manifest.samples) if item.source_vantage
    )
    recovery_indices = tuple(
        index for index, item in enumerate(manifest.samples) if item.recovery_pose
    )
    if not source_indices:
        reasons.append("the corridor contains no source vantage pose")
    if not recovery_indices:
        reasons.append("the corridor contains no recovery pose")
    if not destinations:
        reasons.append("the corridor contains no required destination")

    accepted = not reasons
    values = {
        "profile": "exulanica.corridor-artifact/v1",
        "manifest_digest": manifest.digest,
        "reconstruction_digest": manifest.reconstruction_digest,
        "topology_digest": manifest.topology_digest,
        "centreline": [list(item.position_metres) for item in manifest.samples],
        "lateral_half_widths": widths,
        "collision_proxy": {
            "clearance_radii_metres": [
                item.clearance_radius_metres for item in manifest.samples
            ],
            "agent_radius_metres": manifest.agent_radius_metres,
        },
        "navigation_surface": {
            "slope_degrees": [item.slope_degrees for item in manifest.samples],
        },
        "forwards": [list(item.forward) for item in manifest.samples],
        "look_envelope_degrees": {
            "maximum_yaw": manifest.maximum_look_yaw_degrees,
            "minimum_pitch": manifest.minimum_look_pitch_degrees,
            "maximum_pitch": manifest.maximum_look_pitch_degrees,
        },
        "required_destinations": [
            {"destination_ref": name, "centreline_index": index}
            for name, index in destinations
        ],
        "source_vantage_indices": list(source_indices),
        "recovery_pose_indices": list(recovery_indices),
        "accepted": accepted,
        "published_rung": 2 if accepted else 3,
        "reasons": sorted(set(reasons)),
    }
    return CorridorArtifact(
        manifest_digest=manifest.digest,
        reconstruction_digest=manifest.reconstruction_digest,
        topology_digest=manifest.topology_digest,
        centreline=tuple(item.position_metres for item in manifest.samples),
        lateral_half_widths=tuple(widths),
        collision_clearance_radii=tuple(
            item.clearance_radius_metres for item in manifest.samples
        ),
        surface_slope_degrees=tuple(item.slope_degrees for item in manifest.samples),
        agent_radius_metres=manifest.agent_radius_metres,
        forwards=tuple(item.forward for item in manifest.samples),
        maximum_look_yaw_degrees=manifest.maximum_look_yaw_degrees,
        minimum_look_pitch_degrees=manifest.minimum_look_pitch_degrees,
        maximum_look_pitch_degrees=manifest.maximum_look_pitch_degrees,
        required_destinations=tuple(destinations),
        source_vantage_indices=source_indices,
        recovery_pose_indices=recovery_indices,
        accepted=accepted,
        published_rung=2 if accepted else 3,
        reasons=tuple(sorted(set(reasons))),
        sha256=_digest(values),
    )


def validate_corridor_artifact(
    artifact: CorridorArtifact,
    *,
    reconstruction_digest: str,
    topology_digest: str,
) -> None:
    """Refuse mutation, stale bases, malformed widths, or a failed artifact called rung 2."""
    if artifact.sha256 != _digest(artifact.unsigned_payload()):
        raise ValueError("corridor artifact digest mismatch")
    if artifact.reconstruction_digest != reconstruction_digest:
        raise ValueError("corridor artifact is stale against reconstruction")
    if artifact.topology_digest != topology_digest:
        raise ValueError("corridor artifact is stale against topology")
    count = len(artifact.centreline)
    if (
        count < 2
        or len(artifact.lateral_half_widths) != count
        or len(artifact.collision_clearance_radii) != count
        or len(artifact.surface_slope_degrees) != count
        or len(artifact.forwards) != count
    ):
        raise ValueError("corridor arrays do not describe the same measured poses")
    if any(value < 0 or not math.isfinite(value) for value in artifact.lateral_half_widths):
        raise ValueError("corridor lateral widths must be finite and non-negative")
    if artifact.agent_radius_metres <= 0 or not math.isfinite(artifact.agent_radius_metres):
        raise ValueError("corridor agent radius is invalid")
    if any(value < 0 or not math.isfinite(value) for value in artifact.collision_clearance_radii):
        raise ValueError("corridor collision clearance is invalid")
    if artifact.accepted and any(
        value < artifact.agent_radius_metres for value in artifact.collision_clearance_radii
    ):
        raise ValueError("accepted corridor does not clear the agent radius")
    if artifact.accepted != (artifact.published_rung == 2) or (
        artifact.accepted and artifact.reasons
    ):
        raise ValueError("corridor rung contradicts its quality result")

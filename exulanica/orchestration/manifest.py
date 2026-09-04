"""Strict input contract for a reproducible frontier demonstration.

The manifest is an authorization boundary, not a convenient directory listing.  Every regular
file in the supplied photo directory must be named, every named byte count and digest must
match, and symbolic links are refused.  This lets the command say exactly which source set it
processed without quietly including a thumbnail, sidecar, or newly added photograph.

Precomputed artifacts may be disclosed, but this version cannot consume them.  Their required
``use`` value is therefore ``disclose-only``.  Accepting a path and then silently substituting
its result for a stage would make the formation ledger false; rejecting that substitution keeps
the expensive-work boundary explicit until a reviewed importer exists.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Final

from exulanica.canonical import canonical_json
from exulanica.ingest.pipeline import SUPPORTED_SUFFIXES
from exulanica.models.manifest import MANIFEST_PATH as MODEL_MANIFEST_PATH

__all__ = [
    "BUILD_PROFILE",
    "BuildManifest",
    "BuildManifestError",
    "PipelineConfiguration",
    "PrecomputedArtifact",
    "SourceFile",
    "load_build_manifest",
]

BUILD_PROFILE: Final = "exulanica-frontier-build/v1"
_SHA256: Final = re.compile(r"^[0-9a-f]{64}$")


class BuildManifestError(ValueError):
    """A build manifest is malformed or does not describe the supplied bytes."""


@dataclass(frozen=True, slots=True)
class SourceFile:
    path: str
    sha256: str
    bytes: int


@dataclass(frozen=True, slots=True)
class PipelineConfiguration:
    vision: str
    depth: str
    model_manifest_sha256: str


@dataclass(frozen=True, slots=True)
class PrecomputedArtifact:
    artifact_id: str
    kind: str
    sha256: str
    bytes: int
    producer: str
    use: str


@dataclass(frozen=True, slots=True)
class Adaptation:
    profile_id: str
    profile_version: int
    parameters: dict[str, bool | int | str]
    origin_reference: str
    model_id: str
    prompt_version: str
    reference_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class BuildManifest:
    profile: str
    workspace_id: uuid.UUID
    actor_id: uuid.UUID
    world_id: str
    sources: tuple[SourceFile, ...]
    pipeline: PipelineConfiguration
    precomputed_artifacts: tuple[PrecomputedArtifact, ...]
    adaptation: Adaptation
    deletion_path: str
    document: dict[str, Any]
    canonical_sha256: str

    @property
    def source_by_path(self) -> dict[str, SourceFile]:
        return {source.path: source for source in self.sources}

    def validate_photo_directory(self, directory: Path) -> tuple[Path, ...]:
        """Return the exact authorized source paths, after checking the whole directory."""
        if directory.is_symlink() or not directory.is_dir():
            raise BuildManifestError(
                "photo directory is missing, not a directory, or symbolic link"
            )
        root = directory.resolve()
        actual: dict[str, Path] = {}
        for path in sorted(directory.rglob("*")):
            relative = path.relative_to(directory).as_posix()
            if path.is_symlink():
                raise BuildManifestError(f"photo directory contains symbolic link: {relative}")
            if path.is_dir():
                continue
            if not path.is_file():
                raise BuildManifestError(f"photo directory contains a non-regular file: {relative}")
            if path.suffix.lower() not in SUPPORTED_SUFFIXES:
                raise BuildManifestError(f"photo directory contains unsupported file: {relative}")
            actual[relative] = path

        expected = self.source_by_path
        if set(actual) != set(expected):
            missing = sorted(set(expected) - set(actual))
            unlisted = sorted(set(actual) - set(expected))
            raise BuildManifestError(
                f"photo inventory mismatch: missing={missing}, unlisted={unlisted}"
            )
        verified: list[Path] = []
        for source in self.sources:
            path = actual[source.path]
            try:
                path.resolve().relative_to(root)
            except ValueError as exc:  # defensive: symlinks are already refused above
                raise BuildManifestError(f"source escapes photo directory: {source.path}") from exc
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if len(data) != source.bytes or digest != source.sha256:
                raise BuildManifestError(
                    f"source bytes do not match manifest: {source.path} "
                    f"(bytes={len(data)}, sha256={digest})"
                )
            verified.append(path)
        return tuple(verified)


def load_build_manifest(path: Path) -> BuildManifest:
    """Load a strict no-float manifest and verify the checked-in model manifest binding."""
    if path.is_symlink() or not path.is_file():
        raise BuildManifestError("build manifest is missing, not regular, or symbolic link")
    try:
        document = json.loads(path.read_bytes(), object_pairs_hook=_object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildManifestError("build manifest is not valid UTF-8 JSON") from exc
    if not isinstance(document, dict):
        raise BuildManifestError("build manifest must be a JSON object")
    try:
        canonical = canonical_json(document)
    except Exception as exc:
        raise BuildManifestError(
            "build manifest must use the canonical no-float JSON domain"
        ) from exc

    _keys(
        document,
        {
            "profile",
            "workspace_id",
            "actor_id",
            "world_id",
            "sources",
            "pipeline",
            "precomputed_artifacts",
            "adaptation",
            "deletion_demo",
        },
        "manifest",
    )
    if document["profile"] != BUILD_PROFILE:
        raise BuildManifestError(f"unsupported build profile: {document['profile']!r}")
    workspace_id = _uuid(document["workspace_id"], "workspace_id")
    actor_id = _uuid(document["actor_id"], "actor_id")
    world_id = _nonempty(document["world_id"], "world_id")

    raw_sources = _array(document["sources"], "sources")
    if len(raw_sources) < 2:
        raise BuildManifestError("the deletion demonstration requires at least two sources")
    sources = tuple(_source(value, index) for index, value in enumerate(raw_sources))
    paths = [source.path for source in sources]
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        raise BuildManifestError("sources must be unique and sorted by path")
    digests = [source.sha256 for source in sources]
    if len(digests) != len(set(digests)):
        raise BuildManifestError(
            "sources must have unique byte digests so deleting one removes exactly one source"
        )

    pipeline = _pipeline(document["pipeline"])
    actual_model_digest = hashlib.sha256(MODEL_MANIFEST_PATH.read_bytes()).hexdigest()
    if pipeline.model_manifest_sha256 != actual_model_digest:
        raise BuildManifestError(
            "pipeline.model_manifest_sha256 does not match this checkout's model manifest"
        )

    raw_artifacts = _array(document["precomputed_artifacts"], "precomputed_artifacts")
    artifacts = tuple(_precomputed(value, index) for index, value in enumerate(raw_artifacts))
    artifact_ids = [value.artifact_id for value in artifacts]
    if artifact_ids != sorted(artifact_ids) or len(artifact_ids) != len(set(artifact_ids)):
        raise BuildManifestError("precomputed artifacts must be unique and sorted by artifact_id")

    adaptation = _adaptation(document["adaptation"])
    deletion = _mapping(document["deletion_demo"], "deletion_demo")
    _keys(deletion, {"path"}, "deletion_demo")
    deletion_path = _relative_path(deletion["path"], "deletion_demo.path")
    if deletion_path not in set(paths):
        raise BuildManifestError("deletion_demo.path must name one manifest source")

    return BuildManifest(
        profile=BUILD_PROFILE,
        workspace_id=workspace_id,
        actor_id=actor_id,
        world_id=world_id,
        sources=sources,
        pipeline=pipeline,
        precomputed_artifacts=artifacts,
        adaptation=adaptation,
        deletion_path=deletion_path,
        document=document,
        canonical_sha256=hashlib.sha256(canonical).hexdigest(),
    )


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise BuildManifestError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _source(value: Any, index: int) -> SourceFile:
    item = _mapping(value, f"sources[{index}]")
    _keys(item, {"path", "sha256", "bytes"}, f"sources[{index}]")
    path = _relative_path(item["path"], f"sources[{index}].path")
    if Path(path).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise BuildManifestError(f"sources[{index}].path is not a supported image")
    return SourceFile(
        path=path,
        sha256=_sha256(item["sha256"], f"sources[{index}].sha256"),
        bytes=_integer(item["bytes"], f"sources[{index}].bytes", minimum=1),
    )


def _pipeline(value: Any) -> PipelineConfiguration:
    item = _mapping(value, "pipeline")
    _keys(item, {"vision", "depth", "model_manifest_sha256"}, "pipeline")
    vision = _nonempty(item["vision"], "pipeline.vision")
    depth = _nonempty(item["depth"], "pipeline.depth")
    if vision not in {"unavailable", "configured"}:
        raise BuildManifestError("pipeline.vision must be unavailable or configured")
    if depth not in {"unavailable", "moge"}:
        raise BuildManifestError("pipeline.depth must be unavailable or moge")
    return PipelineConfiguration(
        vision=vision,
        depth=depth,
        model_manifest_sha256=_sha256(
            item["model_manifest_sha256"], "pipeline.model_manifest_sha256"
        ),
    )


def _precomputed(value: Any, index: int) -> PrecomputedArtifact:
    label = f"precomputed_artifacts[{index}]"
    item = _mapping(value, label)
    _keys(item, {"artifact_id", "kind", "sha256", "bytes", "producer", "use"}, label)
    use = _nonempty(item["use"], f"{label}.use")
    if use != "disclose-only":
        raise BuildManifestError(
            f"{label}.use must be disclose-only; this profile has no reviewed precomputed importer"
        )
    return PrecomputedArtifact(
        artifact_id=_nonempty(item["artifact_id"], f"{label}.artifact_id"),
        kind=_nonempty(item["kind"], f"{label}.kind"),
        sha256=_sha256(item["sha256"], f"{label}.sha256"),
        bytes=_integer(item["bytes"], f"{label}.bytes", minimum=1),
        producer=_nonempty(item["producer"], f"{label}.producer"),
        use=use,
    )


def _adaptation(value: Any) -> Adaptation:
    item = _mapping(value, "adaptation")
    _keys(
        item,
        {"profile_id", "profile_version", "parameters", "proposal_provenance"},
        "adaptation",
    )
    parameters = _mapping(item["parameters"], "adaptation.parameters")
    if not parameters:
        raise BuildManifestError("adaptation.parameters must not be empty")
    for key, parameter in parameters.items():
        _nonempty(key, "adaptation parameter key")
        if not isinstance(parameter, bool | int | str):
            raise BuildManifestError(
                f"adaptation.parameters.{key} must be a boolean, integer, or string"
            )
    provenance = _mapping(item["proposal_provenance"], "adaptation.proposal_provenance")
    _keys(
        provenance,
        {"origin", "origin_reference", "model_id", "prompt_version", "reference_ids"},
        "adaptation.proposal_provenance",
    )
    if provenance["origin"] != "companion":
        raise BuildManifestError("adaptation proposal provenance must use companion origin")
    raw_reference_ids = _array(
        provenance["reference_ids"], "adaptation.proposal_provenance.reference_ids"
    )
    reference_ids = tuple(
        _nonempty(value, f"adaptation.proposal_provenance.reference_ids[{index}]")
        for index, value in enumerate(raw_reference_ids)
    )
    if not reference_ids or len(set(reference_ids)) != len(reference_ids):
        raise BuildManifestError("adaptation proposal reference_ids must be non-empty and unique")
    return Adaptation(
        profile_id=_nonempty(item["profile_id"], "adaptation.profile_id"),
        profile_version=_integer(item["profile_version"], "adaptation.profile_version", minimum=1),
        parameters=dict(parameters),
        origin_reference=_nonempty(
            provenance["origin_reference"], "adaptation.proposal_provenance.origin_reference"
        ),
        model_id=_nonempty(provenance["model_id"], "adaptation.proposal_provenance.model_id"),
        prompt_version=_nonempty(
            provenance["prompt_version"], "adaptation.proposal_provenance.prompt_version"
        ),
        reference_ids=reference_ids,
    )


def _relative_path(value: Any, label: str) -> str:
    text = _nonempty(value, label)
    path = PurePosixPath(text)
    if path.is_absolute() or "\\" in text or any(part in {"", ".", ".."} for part in path.parts):
        raise BuildManifestError(f"{label} must be a normalized relative POSIX path")
    return path.as_posix()


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BuildManifestError(f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise BuildManifestError(f"{label} must be an array")
    return value


def _keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    missing = sorted(expected - set(value))
    unknown = sorted(set(value) - expected)
    if missing or unknown:
        raise BuildManifestError(f"{label} keys mismatch: missing={missing}, unknown={unknown}")


def _nonempty(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BuildManifestError(f"{label} must be a non-empty string")
    return value


def _integer(value: Any, label: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise BuildManifestError(f"{label} must be an integer >= {minimum}")
    return value


def _sha256(value: Any, label: str) -> str:
    text = _nonempty(value, label)
    if _SHA256.fullmatch(text) is None:
        raise BuildManifestError(f"{label} must be a lowercase SHA-256 digest")
    return text


def _uuid(value: Any, label: str) -> uuid.UUID:
    try:
        return uuid.UUID(_nonempty(value, label))
    except ValueError as exc:
        raise BuildManifestError(f"{label} must be a UUID") from exc

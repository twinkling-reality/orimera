"""The reviewed registry for world profiles and renderer capabilities.

This is deliberately a closed registry.  A style proposal can choose and narrow registered
controls; it cannot submit a schema, executable renderer binding, stylesheet, shader, markup, or
asset URL.  Adding a new capability means changing the versioned registry file and its contract
tests in review.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

from orimera.world.errors import InvalidStyleData
from orimera.world.models import StyleParameterValue, StyleReference

__all__ = [
    "STYLE_REGISTRY",
    "CapabilityDefinition",
    "ParameterDefinition",
    "ProfileDefinition",
    "StyleRegistry",
]

_ID: Final = re.compile(r"^[a-z][a-z0-9.-]*$")
_COLOUR: Final = re.compile(r"^#[0-9a-fA-F]{6}$")
_AVAILABLE: Final = frozenset({"supported", "experimental"})
_KINDS: Final = frozenset({"range", "choice", "color", "toggle"})
_GROUPS: Final = frozenset({"world", "material", "atmosphere", "motion", "detail"})


@dataclass(frozen=True, slots=True)
class CapabilityDefinition:
    capability: str
    kind: str
    group: str
    minimum: float | None = None
    maximum: float | None = None


@dataclass(frozen=True, slots=True)
class ParameterDefinition:
    key: str
    capability: str
    kind: str
    group: str
    label: str
    description: str
    default_value: StyleParameterValue
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    options: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ProfileDefinition:
    profile_id: str
    profile_version: int
    display_name: str
    description: str
    compatibility_key: str
    status: str
    fallback_key: tuple[str, int]
    controls: Mapping[str, ParameterDefinition]

    @property
    def key(self) -> tuple[str, int]:
        return self.profile_id, self.profile_version


class StyleRegistry:
    """Validated profile data with no dynamic registration path."""

    def __init__(self, document: Mapping[str, Any]) -> None:
        if document.get("schema_version") != 1:
            raise ValueError("world style registry schema_version must be 1")
        self._capabilities = self._read_capabilities(document.get("capabilities"))
        self._profiles = self._read_profiles(document.get("profiles"))
        default = document.get("default_profile")
        if not isinstance(default, Mapping):
            raise ValueError("world style registry needs a default_profile")
        self.default_key = (str(default.get("profile_id")), int(default.get("profile_version", 0)))
        if self.default_key not in self._profiles:
            raise ValueError("default world style profile is not registered")
        if not self.is_available(self._profiles[self.default_key]):
            raise ValueError("default world style profile must be supported")
        self._validate_fallbacks()

    @classmethod
    def load(cls, path: Path) -> StyleRegistry:
        return cls(json.loads(path.read_text(encoding="utf-8")))

    @property
    def capabilities(self) -> Mapping[str, CapabilityDefinition]:
        return self._capabilities

    @property
    def profiles(self) -> Mapping[tuple[str, int], ProfileDefinition]:
        return self._profiles

    @property
    def default_reference(self) -> StyleReference:
        profile = self._profiles[self.default_key]
        return self._resolved(profile, {})

    @staticmethod
    def is_available(profile: ProfileDefinition) -> bool:
        return profile.status in _AVAILABLE

    def validate_reference(self, reference: StyleReference) -> StyleReference:
        profile = self._profiles.get((reference.profile_id, reference.profile_version))
        if profile is None:
            raise InvalidStyleData(
                f"unknown world profile {reference.profile_id}@{reference.profile_version}"
            )
        if not self.is_available(profile):
            raise InvalidStyleData(
                f"world profile {reference.profile_id}@{reference.profile_version} is "
                f"{profile.status} and cannot receive new proposals"
            )
        unknown = sorted(set(reference.parameters) - set(profile.controls))
        if unknown:
            raise InvalidStyleData(
                f"unknown parameters for {reference.profile_id}@{reference.profile_version}: "
                + ", ".join(unknown)
            )
        values: dict[str, StyleParameterValue] = {}
        for key, definition in profile.controls.items():
            value = reference.parameters.get(key, definition.default_value)
            self._validate_value(definition, value)
            values[key] = value
        return StyleReference(reference.profile_id, reference.profile_version, values)

    def resolve_reference(
        self, reference: StyleReference
    ) -> tuple[StyleReference, tuple[str, ...]]:
        """Resolve historical data without rewriting it.

        Missing, removed, and unsupported global profiles follow the reviewed fallback chain.
        The result is deterministic for one registry version and carries a warning so an
        interface never presents the fallback as the user's original selection.
        """
        requested = (reference.profile_id, reference.profile_version)
        profile = self._profiles.get(requested)
        warnings: list[str] = []
        if profile is None:
            profile = self._profiles[self.default_key]
            warnings.append(
                f"Unknown world profile {requested[0]}@{requested[1]}; using "
                f"{profile.profile_id}@{profile.profile_version}."
            )
            return self._resolved(profile, {}), tuple(warnings)
        visited: set[tuple[str, int]] = set()
        while not self.is_available(profile):
            if profile.key in visited:
                raise RuntimeError("world style fallback cycle escaped registry validation")
            visited.add(profile.key)
            fallback = self._profiles[profile.fallback_key]
            warnings.append(
                f"World profile {profile.profile_id}@{profile.profile_version} is "
                f"{profile.status}; using {fallback.profile_id}@{fallback.profile_version}."
            )
            profile = fallback
        if profile.key != requested:
            return self._resolved(profile, {}), tuple(warnings)
        try:
            return self.validate_reference(reference), tuple(warnings)
        except InvalidStyleData:
            fallback = self._profiles[self.default_key]
            warnings.append(
                f"Stored parameters for {profile.profile_id}@{profile.profile_version} are no "
                f"longer valid; using {fallback.profile_id}@{fallback.profile_version}."
            )
            return self._resolved(fallback, {}), tuple(warnings)

    def catalog(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "default_profile": self._reference_document(self.default_reference),
            "profiles": [self._profile_document(profile) for profile in self._profiles.values()],
        }

    def _read_capabilities(self, raw: Any) -> Mapping[str, CapabilityDefinition]:
        if not isinstance(raw, list) or not raw:
            raise ValueError("world style registry needs capabilities")
        values: dict[str, CapabilityDefinition] = {}
        for item in raw:
            if not isinstance(item, Mapping):
                raise ValueError("world style capability must be an object")
            key = str(item.get("capability", ""))
            kind = str(item.get("kind", ""))
            group = str(item.get("group", ""))
            if not _ID.fullmatch(key) or kind not in _KINDS or group not in _GROUPS:
                raise ValueError(f"invalid world style capability {key!r}")
            if key in values:
                raise ValueError(f"duplicate world style capability {key}")
            minimum = _optional_number(item.get("min"))
            maximum = _optional_number(item.get("max"))
            if kind == "range" and (minimum is None or maximum is None or minimum >= maximum):
                raise ValueError(f"range capability {key} needs ordered bounds")
            values[key] = CapabilityDefinition(key, kind, group, minimum, maximum)
        return MappingProxyType(values)

    def _read_profiles(self, raw: Any) -> Mapping[tuple[str, int], ProfileDefinition]:
        if not isinstance(raw, list) or not raw:
            raise ValueError("world style registry needs profiles")
        profiles: dict[tuple[str, int], ProfileDefinition] = {}
        for item in raw:
            if not isinstance(item, Mapping):
                raise ValueError("world style profile must be an object")
            profile_id = str(item.get("profile_id", ""))
            version = item.get("profile_version")
            if not _ID.fullmatch(profile_id) or not isinstance(version, int) or version < 1:
                raise ValueError(f"invalid world style profile {profile_id!r}@{version!r}")
            key = (profile_id, version)
            if key in profiles:
                raise ValueError(f"duplicate world style profile {profile_id}@{version}")
            fallback = item.get("fallback")
            if not isinstance(fallback, Mapping):
                raise ValueError(f"world style profile {profile_id}@{version} needs a fallback")
            controls = self._read_controls(key, item.get("controls"))
            profile = ProfileDefinition(
                profile_id=profile_id,
                profile_version=version,
                display_name=_required_text(item, "display_name"),
                description=_required_text(item, "description"),
                compatibility_key=_required_text(item, "compatibility_key"),
                status=str(item.get("status", "")),
                fallback_key=(
                    str(fallback.get("profile_id", "")),
                    int(fallback.get("profile_version", 0)),
                ),
                controls=controls,
            )
            if profile.status not in {"supported", "experimental", "removed", "unsupported"}:
                raise ValueError(f"invalid status for {profile_id}@{version}")
            profiles[key] = profile
        return MappingProxyType(profiles)

    def _read_controls(
        self, profile_key: tuple[str, int], raw: Any
    ) -> Mapping[str, ParameterDefinition]:
        if not isinstance(raw, list):
            raise ValueError(f"controls for {profile_key[0]}@{profile_key[1]} must be a list")
        controls: dict[str, ParameterDefinition] = {}
        for item in raw:
            if not isinstance(item, Mapping):
                raise ValueError("world style control must be an object")
            key = str(item.get("key", ""))
            capability_key = str(item.get("capability", ""))
            capability = self._capabilities.get(capability_key)
            if not _ID.fullmatch(key) or key in controls or capability is None:
                raise ValueError(f"invalid or unregistered world style control {key!r}")
            kind = str(item.get("kind", ""))
            group = str(item.get("group", ""))
            if kind != capability.kind or group != capability.group:
                raise ValueError(f"control {key} does not match capability {capability_key}")
            minimum = _optional_number(item.get("min"))
            maximum = _optional_number(item.get("max"))
            step = _optional_number(item.get("step"))
            options = tuple(str(value) for value in item.get("options", ()))
            definition = ParameterDefinition(
                key=key,
                capability=capability_key,
                kind=kind,
                group=group,
                label=_required_text(item, "label"),
                description=_required_text(item, "description"),
                default_value=item.get("default_value"),
                minimum=minimum,
                maximum=maximum,
                step=step,
                options=options,
            )
            self._validate_definition(definition, capability)
            self._validate_value(definition, definition.default_value)
            controls[key] = definition
        return MappingProxyType(controls)

    @staticmethod
    def _validate_definition(
        definition: ParameterDefinition, capability: CapabilityDefinition
    ) -> None:
        if definition.kind == "range":
            capability_minimum = (
                capability.minimum if capability.minimum is not None else definition.minimum
            )
            capability_maximum = (
                capability.maximum if capability.maximum is not None else definition.maximum
            )
            if (
                definition.minimum is None
                or definition.maximum is None
                or definition.step is None
                or definition.minimum >= definition.maximum
                or definition.step <= 0
                or definition.minimum < capability_minimum
                or definition.maximum > capability_maximum
            ):
                raise ValueError(f"invalid range definition {definition.key}")
        elif definition.kind == "choice" and (
            len(definition.options) < 2 or len(set(definition.options)) != len(definition.options)
        ):
            raise ValueError(f"invalid choice definition {definition.key}")

    @staticmethod
    def _validate_value(definition: ParameterDefinition, value: StyleParameterValue | Any) -> None:
        valid = False
        if definition.kind == "range":
            valid = (
                isinstance(value, int | float)
                and not isinstance(value, bool)
                and math.isfinite(value)
                and definition.minimum is not None
                and definition.maximum is not None
                and definition.minimum <= value <= definition.maximum
            )
        elif definition.kind == "choice":
            valid = isinstance(value, str) and value in definition.options
        elif definition.kind == "color":
            valid = isinstance(value, str) and _COLOUR.fullmatch(value) is not None
        elif definition.kind == "toggle":
            valid = isinstance(value, bool)
        if not valid:
            raise InvalidStyleData(f"invalid value for {definition.key} ({definition.capability})")

    def _validate_fallbacks(self) -> None:
        for profile in self._profiles.values():
            if profile.fallback_key not in self._profiles:
                raise ValueError(
                    f"fallback for {profile.profile_id}@{profile.profile_version} is not registered"
                )
            seen: set[tuple[str, int]] = set()
            cursor = profile
            while not self.is_available(cursor):
                if cursor.key in seen:
                    raise ValueError(
                        f"fallback cycle at {cursor.profile_id}@{cursor.profile_version}"
                    )
                seen.add(cursor.key)
                cursor = self._profiles[cursor.fallback_key]

    def _resolved(
        self, profile: ProfileDefinition, supplied: Mapping[str, StyleParameterValue]
    ) -> StyleReference:
        values = {
            key: supplied.get(key, definition.default_value)
            for key, definition in profile.controls.items()
        }
        return StyleReference(profile.profile_id, profile.profile_version, values)

    @staticmethod
    def _reference_document(reference: StyleReference) -> dict[str, Any]:
        return {
            "profile_id": reference.profile_id,
            "profile_version": reference.profile_version,
            "parameters": dict(reference.parameters),
        }

    def _profile_document(self, profile: ProfileDefinition) -> dict[str, Any]:
        return {
            "profile_id": profile.profile_id,
            "profile_version": profile.profile_version,
            "display_name": profile.display_name,
            "description": profile.description,
            "compatibility_key": profile.compatibility_key,
            "status": profile.status,
            "fallback": {
                "profile_id": profile.fallback_key[0],
                "profile_version": profile.fallback_key[1],
            },
            "controls": [
                {
                    "key": control.key,
                    "capability": control.capability,
                    "kind": control.kind,
                    "group": control.group,
                    "label": control.label,
                    "description": control.description,
                    "default_value": control.default_value,
                    **(
                        {
                            "min": control.minimum,
                            "max": control.maximum,
                            "step": control.step,
                        }
                        if control.kind == "range"
                        else {}
                    ),
                    **({"options": list(control.options)} if control.kind == "choice" else {}),
                }
                for control in profile.controls.values()
            ],
        }


def _required_text(item: Mapping[str, Any], key: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"world style registry needs non-empty {key}")
    return value


def _optional_number(value: Any) -> float | None:
    if value is None:
        return None
    if not isinstance(value, int | float) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError("world style numeric bounds must be finite numbers")
    return float(value)


STYLE_REGISTRY = StyleRegistry.load(Path(__file__).with_name("style-registry.v1.json"))

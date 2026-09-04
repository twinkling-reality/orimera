"""The model manifest: the one place a model identifier is allowed to exist.

Every caller names a **role**. Roles are stable; identifiers are not. Two deprecation rounds
landed in roughly ten weeks before this was written, and the demo has to survive unattended from
the end of October to at least mid December. A call site that names an identifier is a call site
that breaks silently when that identifier is withdrawn, and nobody is watching in December.

Four consequences follow, and all four are enforced here rather than by convention:

*   Identifiers live in ``models.manifest.json`` beside this module, never in Python source.
    ``tests/test_models_manifest.py`` greps the package and fails if one leaks into code. A
    data file rather than a Python table is what makes that test possible at all, and it is what
    `model-and-service-selection.md` section 6 mitigation 1 asks for by name.
*   Every role declares a fallback identifier, so a withdrawal degrades answer quality instead
    of killing the request. One role, embedding, genuinely has no same-tier fallback in the
    catalog; it declares ``null`` and the client raises rather than substituting a model from a
    different vector space, which would silently poison every stored vector.
*   ``pipeline_version`` lives in the manifest. Changing an identifier is required to bump it,
    which invalidates every cached response produced by the model being replaced. A cache that
    outlived the model that filled it would be a correctness bug wearing a cost saving's coat.
*   Prices are read with ``json.loads(parse_float=Decimal)`` and stay ``Decimal`` all the way to
    the reported total. Money never becomes a float here: a float dollar amount accumulated over
    a corpus is a number nobody can reconcile against an invoice.

**Casing is load bearing.** The catalog's human-readable ``name`` field differs from the callable
``model_id``, inconsistently across the reasoning line: one identifier doubles its vendor prefix,
another is entirely lowercase, a third uses an underscore where its display name uses a dot. The
manifest and the preflight both read ``flavors[].model_id`` and never ``name``. A typo here is a
silent 404-class failure.

**Region strings are informational.** Token Factory reports its public endpoints as Region
"Global" and warns the processing location can change without notice, so only the global base URL
is ever used and nothing in this codebase branches on a region.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Any, Final

from orimera.models.errors import ManifestError

__all__ = [
    "MANIFEST_PATH",
    "PROVIDER",
    "Manifest",
    "ModelSpec",
    "Role",
    "RoleBinding",
    "load_manifest",
    "load_manifest_from",
    "parse_manifest",
]

MANIFEST_PATH: Final = Path(__file__).with_name("models.manifest.json")

#: Recorded on every ledger row and every ``model_ref``. One provider today, named explicitly so
#: a second one later is an added value rather than an ambiguous blank.
PROVIDER: Final = "nebius_token_factory"


class Role(StrEnum):
    """What a call site asks for. Never an identifier, never a vendor, never a size."""

    REASONING_CHEAP = "reasoning_cheap"
    REASONING_MID = "reasoning_mid"
    REASONING_HARD = "reasoning_hard"
    VISION = "vision"
    STRUCTURED_EXTRACTION = "structured_extraction"
    EMBEDDING = "embedding"


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """One catalog identifier and the facts about it the client needs at runtime.

    ``min_max_tokens`` is the operationally important one. The reasoning models on this platform
    spend roughly 150 to 215 tokens thinking before emitting a single token of answer, on every
    call, and that cannot be disabled. A ``max_tokens`` under that floor returns HTTP 200 with
    ``finish_reason: "length"`` and an empty answer, which reads as a model failure and is not
    one. That mistake has already produced one false negative in this project's own verification
    harness, so the floor is data the client enforces rather than a comment nobody reads.
    """

    model_id: str
    input_usd_per_mtok: Decimal
    output_usd_per_mtok: Decimal
    context_window_tokens: int
    min_max_tokens: int | None
    default_max_tokens: int | None
    emits_inline_reasoning: bool
    supports_json_schema: bool
    catalog_type: str
    catalog_use_cases: tuple[str, ...]
    catalog_license: str
    region_informational: str
    embedding_dimensions: int | None = None
    note: str = ""

    def cost_usd(self, *, prompt_tokens: int, completion_tokens: int) -> Decimal:
        """Billable cost of one call, exactly.

        ``completion_tokens`` already contains ``reasoning_tokens`` on this platform (measured:
        154 completion of which 149 reasoning), so reasoning is charged here exactly once and is
        never added on top.

        Cached prompt tokens are billed at the full input price. The API reports
        ``prompt_cache_hit_tokens`` but publishes no discount for them, so the conservative
        reading is the one used: an estimate that is too low is worse than one that is too high.
        """
        if prompt_tokens < 0 or completion_tokens < 0:
            raise ManifestError("token counts may not be negative")
        return (
            Decimal(prompt_tokens) * self.input_usd_per_mtok
            + Decimal(completion_tokens) * self.output_usd_per_mtok
        ) / Decimal(1_000_000)

    def model_ref(self, *, endpoint: str) -> dict[str, str]:
        """The ``model_ref`` shape the pipeline ledger stores: provider, id, endpoint.

        ``revision`` is deliberately absent. Token Factory exposes no per-model revision for
        serverless endpoints, and a field invented here would be a fact the ledger cannot
        support.
        """
        return {"provider": PROVIDER, "model_id": self.model_id, "endpoint": endpoint}


@dataclass(frozen=True, slots=True)
class RoleBinding:
    """A role, its primary model, and the model tried when the primary is withdrawn."""

    role: Role
    primary: ModelSpec
    fallback: ModelSpec | None
    required_use_cases: tuple[str, ...]
    rationale: str

    @property
    def chain(self) -> tuple[ModelSpec, ...]:
        """Primary first, then fallback. The order the client tries them in."""
        return (self.primary,) if self.fallback is None else (self.primary, self.fallback)

    @property
    def min_max_tokens(self) -> int:
        """The strictest reasoning floor in the chain.

        Deliberately the maximum over the chain rather than the primary's own floor. If the floor
        were checked against the primary only, a fallback with a larger reasoning overhead would
        begin truncating the moment it was reached, which is exactly the situation in which
        nobody is watching.
        """
        floors = [spec.min_max_tokens for spec in self.chain if spec.min_max_tokens is not None]
        if not floors:
            raise ManifestError(
                f"role {self.role} declares no max_tokens floor, so it is not a chat role"
            )
        return max(floors)

    @property
    def default_max_tokens(self) -> int:
        """Used when a caller does not specify one. Never below the chain's floor."""
        defaults = [
            spec.default_max_tokens for spec in self.chain if spec.default_max_tokens is not None
        ]
        if not defaults:
            raise ManifestError(f"role {self.role} declares no default max_tokens")
        return max(max(defaults), self.min_max_tokens)


@dataclass(frozen=True, slots=True)
class Manifest:
    """The parsed manifest. Immutable, and the only source of identifiers in the process."""

    manifest_version: str
    pipeline_version: int
    base_url: str
    catalog_url: str
    api_key_env: str
    catalog_retrieved_at: str
    models: Mapping[str, ModelSpec]
    roles: Mapping[Role, RoleBinding]

    def __getitem__(self, role: Role | str) -> RoleBinding:
        try:
            return self.roles[Role(role)]
        except (KeyError, ValueError) as exc:
            known = ", ".join(sorted(r.value for r in Role))
            raise ManifestError(
                f"no binding for role {role!r}; the manifest binds {known}"
            ) from exc

    def spec(self, model_id: str) -> ModelSpec:
        try:
            return self.models[model_id]
        except KeyError as exc:
            raise ManifestError(f"{model_id!r} is not declared in the manifest") from exc

    @property
    def model_ids(self) -> frozenset[str]:
        """Every identifier the manifest declares, whether or not a role reaches it."""
        return frozenset(self.models)

    def referenced_model_ids(self) -> frozenset[str]:
        """Identifiers reachable through a role. This is what the preflight checks.

        Fallbacks are included. A fallback that has itself been removed is a failover that fails,
        which is worse than no failover because it is only discovered under load.
        """
        reachable: set[str] = set()
        for binding in self.roles.values():
            reachable.update(spec.model_id for spec in binding.chain)
        return frozenset(reachable)


def _spec_from(model_id: str, raw: Mapping[str, Any]) -> ModelSpec:
    def need(key: str) -> Any:
        if key not in raw:
            raise ManifestError(f"{model_id}: manifest entry is missing {key!r}")
        return raw[key]

    def as_decimal(key: str) -> Decimal:
        value = need(key)
        if isinstance(value, Decimal):
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return Decimal(value)
        raise ManifestError(f"{model_id}: {key} must be a JSON number, got {type(value).__name__}")

    def as_optional_int(key: str) -> int | None:
        value = need(key)
        return None if value is None else int(value)

    return ModelSpec(
        model_id=model_id,
        input_usd_per_mtok=as_decimal("input_usd_per_mtok"),
        output_usd_per_mtok=as_decimal("output_usd_per_mtok"),
        context_window_tokens=int(need("context_window_tokens")),
        min_max_tokens=as_optional_int("min_max_tokens"),
        default_max_tokens=as_optional_int("default_max_tokens"),
        emits_inline_reasoning=bool(need("emits_inline_reasoning")),
        supports_json_schema=bool(need("supports_json_schema")),
        catalog_type=str(need("catalog_type")),
        catalog_use_cases=tuple(str(u) for u in need("catalog_use_cases")),
        catalog_license=str(need("catalog_license")),
        region_informational=str(need("region_informational")),
        embedding_dimensions=(
            None if raw.get("embedding_dimensions") is None else int(raw["embedding_dimensions"])
        ),
        note=str(raw.get("note", "")),
    )


def _reject_unknown_roles(raw_roles: Mapping[str, Any]) -> None:
    """Reject a role name the Role enum does not know, naming the offender."""
    unknown = sorted(set(raw_roles) - {role.value for role in Role})
    if unknown:
        raise ManifestError(
            "manifest declares roles the code does not know: "
            + ", ".join(unknown)
            + ". Add them to Role, or remove them from the manifest."
        )


def parse_manifest(document: Mapping[str, Any]) -> Manifest:
    """Validate a manifest document and freeze it. Raises ``ManifestError`` on anything wrong."""
    for key in ("models", "roles", "pipeline_version", "base_url", "catalog_url", "api_key_env"):
        if key not in document:
            raise ManifestError(f"manifest is missing top-level key {key!r}")

    raw_models: Mapping[str, Any] = document["models"]
    raw_roles: Mapping[str, Any] = document["roles"]
    specs = {model_id: _spec_from(model_id, raw) for model_id, raw in raw_models.items()}

    _reject_unknown_roles(raw_roles)
    missing = {role.value for role in Role} - set(raw_roles)
    if missing:
        raise ManifestError(
            "manifest does not bind every role. Missing: " + ", ".join(sorted(missing))
        )

    bindings: dict[Role, RoleBinding] = {}
    for name, raw in raw_roles.items():
        role = Role(name)
        primary_id = raw["primary"]
        fallback_id = raw.get("fallback")
        if primary_id not in specs:
            raise ManifestError(f"role {role}: primary {primary_id!r} has no model entry")
        if fallback_id is not None and fallback_id not in specs:
            raise ManifestError(f"role {role}: fallback {fallback_id!r} has no model entry")
        if fallback_id == primary_id:
            raise ManifestError(
                f"role {role}: the fallback is the same identifier as the primary, which is not a "
                "fallback. Declare null if this role genuinely has none."
            )
        bindings[role] = RoleBinding(
            role=role,
            primary=specs[primary_id],
            fallback=None if fallback_id is None else specs[fallback_id],
            required_use_cases=tuple(str(u) for u in raw.get("required_use_cases", ())),
            rationale=str(raw.get("rationale", "")),
        )

    return Manifest(
        manifest_version=str(document.get("manifest_version", "0")),
        pipeline_version=int(document["pipeline_version"]),
        base_url=str(document["base_url"]).rstrip("/"),
        catalog_url=str(document["catalog_url"]),
        api_key_env=str(document["api_key_env"]),
        catalog_retrieved_at=str(document.get("catalog_retrieved_at", "")),
        models=specs,
        roles=bindings,
    )


def load_manifest_from(path: Path) -> Manifest:
    """Load and validate a manifest from an explicit path. Not cached."""
    try:
        # parse_float=Decimal keeps prices exact from disk all the way to the reported total.
        document = json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)
    except FileNotFoundError as exc:
        raise ManifestError(f"no model manifest at {path}") from exc
    except json.JSONDecodeError as exc:
        raise ManifestError(f"model manifest at {path} is not valid JSON: {exc}") from exc
    return parse_manifest(document)


@lru_cache(maxsize=1)
def load_manifest() -> Manifest:
    """The process-wide manifest. Cached, because it is read on every call site's first use."""
    return load_manifest_from(MANIFEST_PATH)

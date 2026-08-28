"""Model access: one manifest, one client, one structured-output mechanism.

Callers name a role. No provider identifier appears anywhere in this package's Python source;
they live in ``models.manifest.json``, and ``tests/test_models_manifest.py`` fails if one leaks into
code. Nothing here can reach the ``guided_json`` parameter, which this endpoint accepts, ignores,
and answers with prose and an HTTP 200.
"""

from __future__ import annotations

from orimera.models.budget import DEFAULT_CEILING_USD, DEFAULT_MAX_CALLS, BudgetGuard
from orimera.models.cache import (
    CacheKey,
    FileResponseCache,
    InMemoryResponseCache,
    NullResponseCache,
    ResponseCache,
    cache_key,
    request_digest,
)
from orimera.models.client import (
    ChatResult,
    EmbeddingResult,
    ModelClient,
    StructuredResult,
    api_key_from_env,
    image_part,
    text_part,
)
from orimera.models.errors import (
    AmbiguousStructuredOutputError,
    BudgetExceededError,
    GuidedJsonForbiddenError,
    ManifestError,
    MaxTokensTooLowError,
    ModelError,
    ModelUnavailableError,
    NoFallbackError,
    PreflightError,
    SchemaViolationError,
    StructuredOutputError,
    TransportError,
    TruncatedResponseError,
)
from orimera.models.manifest import (
    PROVIDER,
    Manifest,
    ModelSpec,
    Role,
    RoleBinding,
    load_manifest,
)
from orimera.models.preflight import PreflightReport, run_preflight
from orimera.models.reasoning import SplitContent, split_message, split_reasoning
from orimera.models.schema import (
    extract_json_object,
    json_object_candidates,
    response_format_for,
    response_format_for_schema,
    strict_json_schema,
    validate_against_schema,
)
from orimera.models.transport import HttpResponse, HttpxTransport, Transport
from orimera.models.usage import CallUsage, CostLedger

__all__ = [
    "DEFAULT_CEILING_USD",
    "DEFAULT_MAX_CALLS",
    "PROVIDER",
    "AmbiguousStructuredOutputError",
    "BudgetExceededError",
    "BudgetGuard",
    "CacheKey",
    "CallUsage",
    "ChatResult",
    "CostLedger",
    "EmbeddingResult",
    "FileResponseCache",
    "GuidedJsonForbiddenError",
    "HttpResponse",
    "HttpxTransport",
    "InMemoryResponseCache",
    "Manifest",
    "ManifestError",
    "MaxTokensTooLowError",
    "ModelClient",
    "ModelError",
    "ModelSpec",
    "ModelUnavailableError",
    "NoFallbackError",
    "NullResponseCache",
    "PreflightError",
    "PreflightReport",
    "ResponseCache",
    "Role",
    "RoleBinding",
    "SchemaViolationError",
    "SplitContent",
    "StructuredOutputError",
    "StructuredResult",
    "Transport",
    "TransportError",
    "TruncatedResponseError",
    "api_key_from_env",
    "cache_key",
    "extract_json_object",
    "image_part",
    "json_object_candidates",
    "load_manifest",
    "request_digest",
    "response_format_for",
    "response_format_for_schema",
    "run_preflight",
    "split_message",
    "split_reasoning",
    "strict_json_schema",
    "text_part",
    "validate_against_schema",
]

"""The Token Factory client. Routing by role, one structured-output mechanism, one fallback rule.

Everything here exists because of something that was measured, not assumed:

*   **Routing is by role.** A caller never names a model. The manifest names models; this client
    resolves a role to a chain and walks it.
*   **Fallback fires on a 404-class error and nothing else.** A withdrawn identifier is the one
    failure a different model can fix. A 429, a 500 or a timeout is the same model having a bad
    moment, and switching models in response would hide a platform incident behind a quality
    regression that nobody would ever attribute correctly. The fallback path is exercised by
    ``tests/test_models_client.py`` rather than first executed in front of a judge.
*   **``max_tokens`` has a floor.** The reasoning models spend 150 to 215 tokens thinking before
    writing anything, on every call, and it cannot be disabled. Under the floor, the endpoint
    returns HTTP 200 with ``finish_reason: "length"`` and an empty answer. That looks exactly
    like a model that cannot do the task and is not one: it already produced one false negative
    in this project's own verification harness. The floor is checked before the request, and a
    truncation that survives the check is raised as a parameter bug rather than salvaged.
*   **Structured output goes through ``response_format {type: json_schema, strict: true}`` and
    nowhere else.** A top-level ``guided_json`` is accepted and silently ignored: HTTP 200,
    prose body, no schema enforced. This client refuses to send it, and refuses any
    ``response_format`` it did not build, so naked prose cannot enter canonical state through it.
*   **Sending a schema is not the same as the schema being enforced, so the reply is validated
    locally against the exact schema that was sent.** ``guided_json`` proved on this very
    platform that a constraint parameter can be accepted, ignored, and answered with an HTTP 200
    that looks fine. Every reply to a request carrying a ``response_format`` comes back through
    ``ChatResult.payload`` already checked, so a caller with a hand-written schema gets the same
    guarantee ``structured`` gives rather than inheriting raw text.
*   **Reasoning text is separated from the answer, and an ambiguous answer is refused.** Both
    observed shapes are handled; see ``orimera.models.reasoning``. Where the scratch work is
    untagged and contains a draft JSON object, there is nothing in the body identifying which
    object is the answer, and the call fails rather than guessing. See
    ``orimera.models.schema.extract_json_object``.

The client holds a cache, a budget guard and a ledger. All three are optional collaborators with
inert defaults, so a caller gets no caching and generous limits unless it asks, and a test gets
exact ones.
"""

from __future__ import annotations

import base64
import os
import random
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Generic, TypeVar

from pydantic import BaseModel, ValidationError

from orimera.models.budget import BudgetGuard
from orimera.models.cache import NullResponseCache, ResponseCache, cache_key
from orimera.models.errors import (
    AmbiguousStructuredOutputError,
    GuidedJsonForbiddenError,
    MaxTokensTooLowError,
    ModelError,
    ModelUnavailableError,
    NoFallbackError,
    StructuredOutputError,
    TransportError,
    TruncatedResponseError,
)
from orimera.models.manifest import PROVIDER, Manifest, ModelSpec, Role, load_manifest
from orimera.models.reasoning import SplitContent, split_message
from orimera.models.schema import (
    extract_json_object,
    response_format_for,
    validate_against_schema,
)
from orimera.models.transport import HttpResponse, HttpxTransport, Transport
from orimera.models.usage import CallUsage, CostLedger

__all__ = [
    "ChatResult",
    "EmbeddingResult",
    "ModelClient",
    "StructuredResult",
    "api_key_from_env",
    "image_part",
    "text_part",
]

T = TypeVar("T", bound=BaseModel)

_DEFAULT_TIMEOUT: Final = 180.0

#: A payload naming any of these is refused before it reaches the network. ``guided_json`` and
#: its relatives are the silent-failure family: accepted, ignored, HTTP 200, prose returned.
_FORBIDDEN_PARAMS: Final = frozenset(
    {"guided_json", "guided_regex", "guided_choice", "guided_grammar"}
)

#: Statuses worth issuing the identical request again for. Everything else the endpoint
#: understood and refused, and it will refuse it identically forever. 404 is absent on purpose:
#: a withdrawn identifier is answered by the fallback, never by asking again.
_RETRYABLE_STATUS: Final = frozenset({408, 409, 425, 429, 500, 502, 503, 504})

#: Provider phrasing for "that identifier does not exist". Some deprecations answer 400 rather
#: than 404, so the message is inspected as well as the status.
_NOT_FOUND_PHRASES: Final = (
    "does not exist",
    "not found",
    "unknown model",
    "no such model",
    "invalid model",
    "model_not_found",
)


def text_part(text: str) -> dict[str, Any]:
    """A ``text`` content part."""
    return {"type": "text", "text": text}


def image_part(
    image: bytes | str, *, media_type: str = "image/jpeg", detail: str | None = None
) -> dict[str, Any]:
    """An ``image_url`` content part, from raw bytes or from a URL.

    Raw bytes become a ``data:`` URI. The corpus is private photographs, so a URL the provider
    has to fetch would mean publishing the image at a reachable address, which is a worse trade
    than the base64 size overhead.

    On downscaling: prompt tokens were measured at 277 for a 256px image and 772 for 768px, so
    nine times the area costs 2.8 times the tokens. Token cost is strongly sub-linear in area,
    and aggressive downscaling therefore buys very little while losing the detail the extraction
    depends on.
    """
    if isinstance(image, bytes):
        encoded = base64.b64encode(image).decode("ascii")
        url = f"data:{media_type};base64,{encoded}"
    else:
        url = image
    part: dict[str, Any] = {"type": "image_url", "image_url": {"url": url}}
    if detail is not None:
        part["image_url"]["detail"] = detail
    return part


def api_key_from_env(env_name: str, *, dotenv: Path | None = None) -> str:
    """Read the credential from the environment, falling back to a ``.env`` file.

    The value is returned and never logged, never echoed into an error message, and never
    written into a cache entry. A ``.env`` value does not override an already-exported variable,
    so a deliberately exported key wins over a stale file.
    """
    value = os.environ.get(env_name)
    if value and value.strip():
        return value.strip()

    if dotenv is None:
        here = Path.cwd()
        for candidate in (here, *here.parents):
            probe = candidate / ".env"
            if probe.exists():
                dotenv = probe
                break
    if dotenv is not None and dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            name, _, raw = stripped.partition("=")
            if name.strip() == env_name:
                return raw.strip().strip('"').strip("'")
    raise ModelError(
        f"no credential: set {env_name} in the environment or in a .env file. "
        "Its value is never printed by this package."
    )


@dataclass(frozen=True, slots=True)
class ChatResult:
    """One completed chat call, with everything the ledger and the caller need."""

    role: Role
    model_id: str
    served_model_id: str
    answer: str
    reasoning: str | None
    finish_reason: str
    usage: CallUsage
    raw: Mapping[str, Any]
    cache_hit: bool
    used_fallback: bool
    endpoint: str = ""
    #: HTTP requests actually issued, retries and failover attempts included. Zero on a cache
    #: hit, and that zero is the point: the ledger shows a stage that cost no request.
    attempts: int = 0
    #: Every identifier tried, in order, including the ones that failed. A silent failover is
    #: visible in the Assembly Replay only because this is recorded rather than inferred.
    tried: tuple[str, ...] = ()
    #: The parsed answer, already validated against the exact schema the request sent. Present
    #: whenever a ``response_format`` was sent and ``None`` otherwise, so a caller that reads it
    #: is reading data the client checked rather than data it merely relayed. A caller with a
    #: hand-written schema, such as the vision path, gets the same guarantee ``structured``
    #: gives without re-parsing the answer itself.
    payload: Mapping[str, Any] | None = None

    @property
    def model_ref(self) -> dict[str, str]:
        """Provider, identifier, endpoint: the shape ``pipeline_event.model_ref`` stores.

        ``revision`` is deliberately absent. Token Factory exposes no per-model revision for
        serverless endpoints, and a field invented here would be a fact the ledger cannot
        support.
        """
        return {"provider": PROVIDER, "model_id": self.model_id, "endpoint": self.endpoint}


@dataclass(frozen=True, slots=True)
class StructuredResult(Generic[T]):
    """A validated instance plus the call that produced it.

    The call is kept because the ledger needs it and because a disputed extraction has to be
    traceable to the response that produced it, not merely to the value that survived it.
    """

    value: T
    call: ChatResult


@dataclass(frozen=True, slots=True)
class EmbeddingResult:
    model_id: str
    vectors: tuple[tuple[float, ...], ...]
    usage: CallUsage
    dimensions: int


class ModelClient:
    """Role-routed access to the OpenAI-compatible endpoint."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        manifest: Manifest | None = None,
        transport: Transport | None = None,
        cache: ResponseCache | None = None,
        budget: BudgetGuard | None = None,
        timeout: float = _DEFAULT_TIMEOUT,
        max_attempts: int = 1,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._manifest = manifest or load_manifest()
        self._transport = transport if transport is not None else HttpxTransport()
        self._cache: ResponseCache = cache if cache is not None else NullResponseCache()
        self._budget = budget if budget is not None else BudgetGuard()
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._sleep = sleep
        self._api_key = api_key or api_key_from_env(self._manifest.api_key_env)

    # -- introspection ---------------------------------------------------------------------

    @property
    def manifest(self) -> Manifest:
        return self._manifest

    @property
    def budget(self) -> BudgetGuard:
        return self._budget

    @property
    def ledger(self) -> CostLedger:
        return self._budget.ledger

    def __repr__(self) -> str:
        # No credential, not even a prefix of one. A truncated key in a traceback is still a leak.
        return (
            f"ModelClient(base_url={self._manifest.base_url!r}, "
            f"pipeline_version={self._manifest.pipeline_version})"
        )

    # -- request construction --------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    @staticmethod
    def _reject_forbidden(extra: Mapping[str, Any] | None) -> None:
        """Refuse a silently-ignored constraint parameter, wherever it is nested."""

        def scan(node: Any, path: str) -> None:
            if isinstance(node, Mapping):
                for key, value in node.items():
                    if str(key) in _FORBIDDEN_PARAMS:
                        raise GuidedJsonForbiddenError(
                            f"{path}.{key} is accepted by this endpoint and silently ignored: it "
                            "returns HTTP 200 with prose and enforces no schema. Use "
                            "ModelClient.structured, which sends response_format json_schema "
                            "strict, the only mechanism measured to work."
                        )
                    scan(value, f"{path}.{key}")

        scan(extra or {}, "extra")

    def _resolve_max_tokens(self, role: Role, max_tokens: int | None) -> int:
        binding = self._manifest[role]
        floor = binding.min_max_tokens
        if max_tokens is None:
            return binding.default_max_tokens
        if max_tokens < floor:
            raise MaxTokensTooLowError(
                f"max_tokens={max_tokens} is below the floor of {floor} for role {role}. The "
                "models on this chain spend roughly 150 to 215 tokens reasoning before writing "
                "any answer and that cannot be disabled, so a smaller budget returns HTTP 200 "
                'with finish_reason "length" and an empty answer. That reads as a model failure '
                "and is not one."
            )
        return max_tokens

    def _build_payload(
        self,
        *,
        messages: Sequence[Mapping[str, Any]],
        max_tokens: int,
        temperature: float,
        response_format: Mapping[str, Any] | None,
        extra: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        self._reject_forbidden(extra)
        if response_format is not None:
            kind = response_format.get("type")
            strict = (response_format.get("json_schema") or {}).get("strict")
            if kind != "json_schema" or strict is not True:
                raise GuidedJsonForbiddenError(
                    f"response_format type={kind!r} strict={strict!r} is refused. Only "
                    "{'type': 'json_schema', ..., 'strict': True} enforces a schema on this "
                    "endpoint; json_object returns valid JSON of an arbitrary shape, which is "
                    "not a schema, and canonical state may only be written from a validated one."
                )
            if not isinstance((response_format.get("json_schema") or {}).get("schema"), Mapping):
                # Refused here rather than after the reply arrives, because the schema is what
                # the reply is validated against locally. Without it the call would spend money
                # to produce a payload nothing could check.
                raise GuidedJsonForbiddenError(
                    "response_format carries no schema. The schema is not only sent, it is what "
                    "the reply is validated against locally, so a response_format without one "
                    "would buy an answer that nothing can check. Build it with "
                    "orimera.models.schema.response_format_for or response_format_for_schema."
                )
        payload: dict[str, Any] = {
            "messages": [dict(m) for m in messages],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if response_format is not None:
            payload["response_format"] = dict(response_format)
        if extra:
            payload.update(dict(extra))
        return payload

    # -- dispatch --------------------------------------------------------------------------

    @staticmethod
    def _is_model_missing(response: HttpResponse) -> bool:
        """404-class: this identifier does not exist. The only trigger for a fallback."""
        if response.status_code == 404:
            return True
        if response.status_code in (400, 422):
            message = response.error_message().lower()
            return "model" in message and any(p in message for p in _NOT_FOUND_PHRASES)
        return False

    def _post(self, path: str, payload: Mapping[str, Any], spec: ModelSpec) -> dict[str, Any]:
        url = f"{self._manifest.base_url}{path}"
        response = self._transport.post_json(
            url, headers=self._headers(), payload=payload, timeout=self._timeout
        )
        if self._is_model_missing(response):
            raise ModelUnavailableError(
                f"{spec.model_id} is not available: HTTP {response.status_code}. "
                f"{response.error_message()[:200]}",
                model_id=spec.model_id,
                status_code=response.status_code,
            )
        if not response.ok:
            raise TransportError(
                f"HTTP {response.status_code} from {path} for {spec.model_id}: "
                f"{response.error_message()[:300]}",
                retryable=response.status_code in _RETRYABLE_STATUS,
            )
        body = response.json_body()
        if not isinstance(body, dict):
            raise TransportError(
                f"{path} returned a {type(body).__name__}, expected an object", retryable=False
            )
        return body

    def _backoff(self, attempt: int) -> None:
        """Exponential with jitter.

        Jitter matters even for a single client. A corpus pass is one call per photograph, and
        synchronised retries after a rate limit are how a rate limit becomes an outage.
        """
        delay = min(8.0, 0.5 * (2 ** (attempt - 1)))
        self._sleep(delay * (0.5 + random.random() / 2))

    def _post_with_retries(
        self,
        path: str,
        payload: Mapping[str, Any],
        spec: ModelSpec,
        *,
        role: Role,
        prompt_chars: int,
        extra_prompt_tokens: int,
        max_tokens: int,
    ) -> tuple[dict[str, Any], int]:
        """One model, up to ``max_attempts`` requests. Returns the body and requests issued.

        Retries exist because the platform states plainly that Serverless AI "does not provide
        automatic retry, recovery, or redundancy mechanisms". They are off by default
        (``max_attempts=1``) so a caller that knows its operation is not idempotent gets exactly
        one request, and a caller running a corpus pass can opt in.

        Only a retryable status or a failed connection is retried. A ``ModelUnavailableError`` is
        never retried here: the same withdrawn identifier will be withdrawn again, and the answer
        to it is the fallback, one level up. Each attempt is reserved against the budget
        separately, so a retry storm is spend the guard can see.
        """
        for attempt in range(1, self._max_attempts + 1):
            self._budget.reserve(
                spec,
                role=role,
                prompt_chars=prompt_chars,
                max_tokens=max_tokens,
                extra_prompt_tokens=extra_prompt_tokens,
            )
            try:
                return self._post(path, payload, spec), attempt
            except TransportError as exc:
                if not exc.retryable or attempt == self._max_attempts:
                    raise
                self._backoff(attempt)
        raise AssertionError("unreachable: the last attempt either returns or raises")

    def _walk_chain(
        self,
        role: Role,
        path: str,
        payload: Mapping[str, Any],
        *,
        prompt_chars: int,
        extra_prompt_tokens: int,
        max_tokens: int,
    ) -> tuple[dict[str, Any], ModelSpec, bool, float, int, tuple[str, ...]]:
        """Try the primary, then the fallback. Returns the body and which model served it."""
        binding = self._manifest[role]
        failures: list[str] = []
        tried: list[str] = []
        attempts = 0
        for index, spec in enumerate(binding.chain):
            tried.append(spec.model_id)
            started = time.monotonic()
            try:
                body, made = self._post_with_retries(
                    path,
                    {**payload, "model": spec.model_id},
                    spec,
                    role=role,
                    prompt_chars=prompt_chars,
                    extra_prompt_tokens=extra_prompt_tokens,
                    max_tokens=max_tokens,
                )
            except ModelUnavailableError as exc:
                # Not retried, so exactly one request was issued against this identifier.
                attempts += 1
                failures.append(str(exc))
                continue
            return body, spec, index > 0, time.monotonic() - started, attempts + made, tuple(tried)

        detail = "; ".join(failures)
        if binding.fallback is None:
            raise NoFallbackError(
                f"role {role} has no declared fallback and its only model is unavailable. "
                f"{binding.rationale} Original failure: {detail}"
            )
        raise NoFallbackError(
            f"role {role}: every model in the chain is unavailable. This is what a deprecation "
            f"round looks like. Run the preflight against the live catalog. Failures: {detail}"
        )

    # -- chat ------------------------------------------------------------------------------

    def chat(
        self,
        role: Role | str,
        messages: Sequence[Mapping[str, Any]],
        *,
        prompt_version: str,
        max_tokens: int | None = None,
        temperature: float = 0.0,
        response_format: Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
        image_prompt_tokens: int = 0,
        use_cache: bool = True,
    ) -> ChatResult:
        """One chat completion, routed by role.

        ``prompt_version`` is required rather than defaulted. It is part of the cache key, and a
        default would mean editing a prompt and silently getting the previous prompt's answers,
        which is a full afternoon of confusion for the sake of one keyword argument.
        """
        role = Role(role)
        resolved_max = self._resolve_max_tokens(role, max_tokens)
        payload = self._build_payload(
            messages=messages,
            max_tokens=resolved_max,
            temperature=temperature,
            response_format=response_format,
            extra=extra,
        )

        key = cache_key(
            payload,
            pipeline_version=self._manifest.pipeline_version,
            role=role,
            prompt_version=prompt_version,
        )
        if use_cache:
            cached = self._cache.get(key)
            if cached is not None:
                served = self._manifest.spec(cached["model_id"])
                return self._result_from_body(
                    role=role,
                    spec=served,
                    body=cached["response"],
                    cache_hit=True,
                    used_fallback=bool(cached.get("used_fallback", False)),
                    latency_s=0.0,
                    # A cache hit issued no request. Zero attempts is the honest number and it
                    # is what makes "nothing recomputed, nothing billed" checkable.
                    attempts=0,
                    tried=(served.model_id,),
                    # Revalidated on the way out of the cache, not trusted because it was
                    # validated on the way in. The schema can change under a stored entry, and a
                    # cached payload that no longer satisfies the current schema must fail the
                    # same way a fresh one would.
                    response_format=response_format,
                )

        prompt_chars = sum(len(str(m)) for m in messages)
        body, spec, used_fallback, latency, attempts, tried = self._walk_chain(
            role,
            "/chat/completions",
            payload,
            prompt_chars=prompt_chars,
            extra_prompt_tokens=image_prompt_tokens,
            max_tokens=resolved_max,
        )
        result = self._result_from_body(
            role=role,
            spec=spec,
            body=body,
            cache_hit=False,
            used_fallback=used_fallback,
            latency_s=latency,
            attempts=attempts,
            tried=tried,
            response_format=response_format,
        )
        if use_cache:
            # Only the response is cached. Headers carry the credential and never go to disk.
            self._cache.put(
                key,
                {
                    "model_id": spec.model_id,
                    "role": str(role),
                    "pipeline_version": self._manifest.pipeline_version,
                    "prompt_version": prompt_version,
                    "used_fallback": used_fallback,
                    "response": body,
                },
            )
        return result

    def _result_from_body(
        self,
        *,
        role: Role,
        spec: ModelSpec,
        body: Mapping[str, Any],
        cache_hit: bool,
        used_fallback: bool,
        latency_s: float,
        attempts: int,
        tried: tuple[str, ...],
        response_format: Mapping[str, Any] | None = None,
    ) -> ChatResult:
        choices = body.get("choices") or []
        if not choices:
            raise TransportError(f"{spec.model_id} returned no choices", retryable=False)
        choice = choices[0]
        message = choice.get("message") or {}
        finish_reason = str(choice.get("finish_reason") or "")
        split: SplitContent = split_message(message)

        usage = CallUsage.from_response(
            role=role,
            spec=spec,
            usage=body.get("usage"),
            cache_hit=cache_hit,
            used_fallback=used_fallback,
            latency_s=latency_s,
        )
        self._budget.record(usage)

        if finish_reason == "length" and split.empty_answer:
            raise TruncatedResponseError(
                f"{spec.model_id} stopped on the token limit before producing any answer "
                f"({usage.reasoning_tokens} reasoning tokens spent, "
                f"{usage.completion_tokens} completion tokens). This is a max_tokens setting "
                "that does not clear the reasoning overhead, not a model that cannot do the "
                "task. Raise max_tokens."
            )
        if finish_reason == "length":
            raise TruncatedResponseError(
                f"{spec.model_id} truncated the answer on the token limit. A partial answer is "
                "never salvaged: half a result that happens to parse is a plausible fact with a "
                "piece missing. Raise max_tokens and retry."
            )

        payload = (
            None
            if response_format is None
            else self._checked_payload(split.answer, response_format, spec.model_id)
        )

        return ChatResult(
            role=role,
            model_id=spec.model_id,
            served_model_id=str(body.get("model") or spec.model_id),
            answer=split.answer,
            reasoning=split.reasoning,
            finish_reason=finish_reason,
            usage=usage,
            raw=body,
            cache_hit=cache_hit,
            used_fallback=used_fallback,
            endpoint=self._manifest.base_url,
            attempts=attempts,
            tried=tried,
            payload=payload,
        )

    @staticmethod
    def _checked_payload(
        answer: str, response_format: Mapping[str, Any], model_id: str
    ) -> dict[str, Any]:
        """Parse the answer and validate it against the schema this request actually sent.

        Two separate guarantees, and both are wanted. ``extract_json_object`` refuses a body
        that carries more than one candidate object rather than guessing which one was the
        answer; ``validate_against_schema`` then checks the winner against the byte-identical
        schema in ``response_format``, because a request for enforcement is not proof of it.
        ``guided_json`` was measured being accepted and ignored on this platform, and a
        ``json_schema`` the endpoint quietly stopped honouring would look exactly the same from
        the outside: HTTP 200, a plausible object, the wrong shape.

        The parse failure and the shape failure are raised separately on purpose. "Not JSON at
        all" and "JSON of the wrong shape" send a reader to different places, and one message
        covering both sends them to the wrong one.
        """
        declared = response_format.get("json_schema") or {}
        schema = declared.get("schema")
        name = str(declared.get("name") or "response")
        try:
            parsed = extract_json_object(answer)
        except AmbiguousStructuredOutputError:
            raise
        except StructuredOutputError as exc:
            raise StructuredOutputError(
                f"{model_id} returned text that is not JSON and contains no JSON object, even "
                "though response_format was json_schema strict. That is what an unenforced "
                f"schema looks like. Answer was {answer[:300]!r}"
            ) from exc
        if not isinstance(schema, Mapping):
            # response_format is only ever built by orimera.models.schema and only ever accepted
            # by _build_payload after it has checked the type and the strict flag, so this is
            # unreachable from a supported call site. It is still raised rather than skipped:
            # silently returning unvalidated data is the defect this method exists to close.
            raise StructuredOutputError(
                f"{model_id} was sent a response_format carrying no schema, so its reply cannot "
                "be validated locally. Build response_format with orimera.models.schema."
            )
        return validate_against_schema(parsed, schema, name=name)

    # -- structured output ------------------------------------------------------------------

    def structured(
        self,
        role: Role | str,
        messages: Sequence[Mapping[str, Any]],
        schema: type[T],
        *,
        prompt_version: str,
        max_tokens: int | None = None,
        temperature: float = 0.0,
        extra: Mapping[str, Any] | None = None,
        image_prompt_tokens: int = 0,
        use_cache: bool = True,
    ) -> StructuredResult[T]:
        """The only path by which model output may become canonical state.

        Returns a validated instance of ``schema`` or raises. There is no partial success and no
        best-effort parse: a body that does not validate is a failure, because a half-parsed
        object is a fact with a piece missing rather than a smaller fact.
        """
        role = Role(role)
        spec = self._manifest[role].primary
        if not spec.supports_json_schema:
            raise StructuredOutputError(
                f"role {role} is not a structured-output role; its primary model is not declared "
                "to support json_schema in the manifest."
            )
        call = self.chat(
            role,
            messages,
            prompt_version=prompt_version,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=response_format_for(schema),
            extra=extra,
            image_prompt_tokens=image_prompt_tokens,
            use_cache=use_cache,
        )
        # ``chat`` has already refused a body carrying more than one candidate object and
        # validated the survivor against the exact schema it sent, so ``call.payload`` is
        # checked data rather than relayed data. Pydantic then runs over the same payload. The
        # two are not redundant: the JSON Schema check is the one the endpoint was asked to
        # enforce, including additionalProperties false, which Pydantic ignores by default; the
        # Pydantic check is the one this codebase's types depend on. Both are wanted.
        parsed = call.payload
        if parsed is None:  # pragma: no cover - structured always sends a response_format
            raise StructuredOutputError(
                f"{call.model_id} produced no validated payload for {schema.__name__}."
            )
        try:
            value = schema.model_validate(parsed)
        except ValidationError as exc:
            raise StructuredOutputError(
                f"{call.model_id} returned JSON that does not satisfy {schema.__name__} under "
                f"strict json_schema: {exc.error_count()} error(s). Answer was "
                f"{call.answer[:300]!r}"
            ) from exc
        return StructuredResult(value=value, call=call)

    # -- vision ------------------------------------------------------------------------------

    def vision(
        self,
        images: Sequence[bytes | str | Mapping[str, Any]],
        instruction: str,
        *,
        prompt_version: str,
        role: Role | str = Role.VISION,
        schema: type[T] | None = None,
        media_type: str = "image/jpeg",
        system: str | None = None,
        max_tokens: int | None = None,
        image_prompt_tokens: int | None = None,
        use_cache: bool = True,
    ) -> ChatResult | StructuredResult[T]:
        """One call over one or more photographs.

        The single-photograph path is the primary experience, not a degenerate case of a batch,
        so a bare ``bytes`` is accepted directly and needs no wrapping.

        Nothing here trusts the catalog's ``type`` field. The primary vision model is typed
        ``text2text`` and was runtime-verified to accept an ``image_url`` part and describe the
        image correctly; the preflight asserts on ``use_cases`` for the same reason.
        """
        role = Role(role)
        parts: list[dict[str, Any]] = []
        for image in images:
            if isinstance(image, Mapping):
                parts.append(dict(image))
            else:
                parts.append(image_part(image, media_type=media_type))
        parts.append(text_part(instruction))

        messages: list[dict[str, Any]] = []
        if system is not None:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": parts})

        # 772 prompt tokens was measured for a 768px image. Used only to size the budget
        # reservation, never for accounting, which reads the reported usage.
        estimated = 800 * len(images) if image_prompt_tokens is None else image_prompt_tokens

        if schema is None:
            return self.chat(
                role,
                messages,
                prompt_version=prompt_version,
                max_tokens=max_tokens,
                image_prompt_tokens=estimated,
                use_cache=use_cache,
            )
        return self.structured(
            role,
            messages,
            schema,
            prompt_version=prompt_version,
            max_tokens=max_tokens,
            image_prompt_tokens=estimated,
            use_cache=use_cache,
        )

    # -- embeddings ---------------------------------------------------------------------------

    def embed(
        self,
        texts: Sequence[str],
        *,
        role: Role | str = Role.EMBEDDING,
        prompt_version: str = "embed-v1",
        use_cache: bool = True,
    ) -> EmbeddingResult:
        """Embed one or more strings.

        This role has no same-tier fallback: it is the only embedding-typed model in the catalog.
        When it is unavailable the client raises rather than substituting a text model, because a
        vector from a different model is not a worse vector, it is a vector in a different space,
        and mixing spaces silently poisons every stored embedding and every retrieval built on
        them.
        """
        role = Role(role)
        payload: dict[str, Any] = {"input": list(texts)}
        key = cache_key(
            payload,
            pipeline_version=self._manifest.pipeline_version,
            role=role,
            prompt_version=prompt_version,
        )
        cached = self._cache.get(key) if use_cache else None
        if cached is not None:
            spec = self._manifest.spec(cached["model_id"])
            return self._embedding_from_body(role, spec, cached["response"], cache_hit=True)

        body, spec, _used_fallback, _latency, _attempts, _tried = self._walk_chain(
            role,
            "/embeddings",
            payload,
            prompt_chars=sum(len(t) for t in texts),
            extra_prompt_tokens=0,
            max_tokens=0,
        )
        if use_cache:
            self._cache.put(
                key,
                {
                    "model_id": spec.model_id,
                    "role": str(role),
                    "pipeline_version": self._manifest.pipeline_version,
                    "prompt_version": prompt_version,
                    "response": body,
                },
            )
        return self._embedding_from_body(role, spec, body, cache_hit=False)

    def _embedding_from_body(
        self, role: Role, spec: ModelSpec, body: Mapping[str, Any], *, cache_hit: bool
    ) -> EmbeddingResult:
        rows = body.get("data") or []
        vectors = tuple(tuple(float(x) for x in row.get("embedding") or ()) for row in rows)
        usage = CallUsage.from_response(
            role=role, spec=spec, usage=body.get("usage"), cache_hit=cache_hit
        )
        self._budget.record(usage)
        dimensions = len(vectors[0]) if vectors else 0
        expected = spec.embedding_dimensions
        if expected is not None and vectors and dimensions != expected:
            raise ModelError(
                f"{spec.model_id} returned {dimensions}-dimensional vectors, manifest declares "
                f"{expected}. Storing these alongside existing vectors would corrupt the index."
            )
        return EmbeddingResult(
            model_id=spec.model_id, vectors=vectors, usage=usage, dimensions=dimensions
        )

"""Reaching the endpoint for a role: retry, failover, and the budget each attempt is charged to.

A caller never names a model. The manifest names models, a role resolves to a chain of them, and
this walks it. Three policies live here and nowhere else, each because of something measured:

*   **Fallback fires on a 404-class error and nothing else.** A withdrawn identifier is the one
    failure a different model can fix. A 429, a 500 or a timeout is the same model having a bad
    moment, and switching models in response would hide a platform incident behind a quality
    regression that nobody would ever attribute correctly.
*   **Retries are off by default.** The platform states plainly that Serverless AI "does not
    provide automatic retry, recovery, or redundancy mechanisms", so retries exist, but a caller
    whose operation is not idempotent gets exactly one request unless it asks otherwise.
*   **Every attempt is reserved against the budget separately**, so a retry storm is spend the
    guard can see rather than spend it discovers afterwards.

Split out of the client because these are decisions about the network, and the client's own job
is what a request means and whether a reply may be believed. A change to the retry policy should
not be a change to the module that decides whether a model's answer enters canonical state.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from orimera.models.budget import BudgetGuard
from orimera.models.errors import ModelUnavailableError, NoFallbackError, TransportError
from orimera.models.manifest import Manifest, ModelSpec, Role
from orimera.models.transport import HttpResponse, Transport

__all__ = ["ChainResponse", "ModelChain"]

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


@dataclass(frozen=True, slots=True)
class ChainResponse:
    """One body, and everything about how it was obtained.

    A named shape rather than a tuple because six positional values is five chances to read one
    in the wrong slot, and two of them are integers that mean different things.
    """

    body: dict[str, Any]
    spec: ModelSpec
    used_fallback: bool
    latency_s: float
    #: HTTP requests actually issued, retries and failover attempts included.
    attempts: int
    #: Every identifier tried, in order, including the ones that failed.
    tried: tuple[str, ...]


class ModelChain:
    """The endpoint, reached by role rather than by model identifier."""

    def __init__(
        self,
        *,
        manifest: Manifest,
        transport: Transport,
        api_key: str,
        budget: BudgetGuard,
        timeout: float,
        max_attempts: int,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._manifest = manifest
        self._transport = transport
        self._api_key = api_key
        self._budget = budget
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._sleep = sleep

    def __repr__(self) -> str:
        # No credential, not even a prefix of one. A truncated key in a traceback is still a leak.
        return f"ModelChain(base_url={self._manifest.base_url!r})"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

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

    def worst_case_seconds(self, role: Role) -> float:
        """The longest one :meth:`walk` of this role can take, from this chain's own numbers.

        A caller outside the models package cannot compute this and must not guess it: it is the
        product of the manifest's chain length, the transport timeout and the retry count, and
        two of those three are constructor arguments that differ between the API's client and
        the ingest CLI's. :mod:`orimera.ingest.worker` needs it to decide how long a claimant may
        be silent before its silence means something.

        The arithmetic follows :meth:`walk` exactly. A ``ModelUnavailableError`` is not retried,
        so every model before the last costs one request; the last one costs a full retry budget,
        because a retry exhaustion raises out of ``walk`` rather than falling through to a
        fallback. Backoff is added for the gaps between those retries, at its ceiling rather than
        its jittered value.

        **It bounds the arithmetic and not the wall clock**, which is stated here because the
        difference has already been measured on this transport:
        :mod:`orimera.models.transport` passes one float to httpx, which sets connect, read,
        write and pool each to it, and httpx has no total-request timeout. A response that
        dribbles one chunk every ``timeout`` seconds is never cut off. So this is the right
        number to size a lease from and the wrong number to call a guarantee.
        """
        chain = self._manifest[role].chain
        return (len(chain) - 1 + self._max_attempts) * self._timeout + self._backoff_ceiling()

    def _backoff_ceiling(self) -> float:
        """The unjittered sum of the sleeps between ``max_attempts`` requests to one model."""
        return sum(min(8.0, 0.5 * (2 ** (attempt - 1))) for attempt in range(1, self._max_attempts))

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

    def walk(
        self,
        role: Role,
        path: str,
        payload: Mapping[str, Any],
        *,
        prompt_chars: int,
        extra_prompt_tokens: int,
        max_tokens: int,
    ) -> ChainResponse:
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
            return ChainResponse(
                body=body,
                spec=spec,
                used_fallback=index > 0,
                latency_s=time.monotonic() - started,
                attempts=attempts + made,
                tried=tuple(tried),
            )

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

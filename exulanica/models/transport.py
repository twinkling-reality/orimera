"""The HTTP seam.

The client never touches ``httpx`` directly. It goes through ``Transport``, a two-method
protocol, for one reason that is worth the indirection: the fallback path, the budget refusal,
the max_tokens floor and the reasoning split all have to be exercised by tests that spend no
money. A test supplies a ``Transport`` that returns canned bodies, and the code under test is
the same code that runs in production, rather than a mock of it.

The default implementation is ``httpx``. Nothing here retries: retry policy belongs with the
caller that knows whether the operation is idempotent, and a transport that silently retries a
non-idempotent call is a billing surprise.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from exulanica.models.errors import TransportError

__all__ = ["HttpResponse", "HttpxTransport", "Transport"]


@dataclass(frozen=True, slots=True)
class HttpResponse:
    """One HTTP response, already read. Status, headers, decoded body, raw text."""

    status_code: int
    text: str
    headers: Mapping[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json_body(self) -> Any:
        """Decode the body, or raise ``TransportError`` naming the status.

        A non-JSON body from this endpoint is nearly always an HTML error page from something in
        front of the model, so the status code is the useful part of the message.
        """
        try:
            return json.loads(self.text)
        except json.JSONDecodeError as exc:
            excerpt = self.text[:200]
            raise TransportError(
                f"HTTP {self.status_code} body is not JSON: {excerpt!r}"
            ) from exc

    def error_message(self) -> str:
        """Best-effort provider error string, used to classify a 400 as model-not-found."""
        try:
            body = json.loads(self.text)
        except json.JSONDecodeError:
            return self.text[:400]
        if isinstance(body, Mapping):
            error = body.get("error")
            if isinstance(error, Mapping):
                return str(error.get("message") or error)
            if error is not None:
                return str(error)
            if "message" in body:
                return str(body["message"])
        return self.text[:400]


class Transport(Protocol):
    """What the client needs from the network, and nothing more."""

    def post_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout: float,
    ) -> HttpResponse: ...

    def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> HttpResponse: ...


class HttpxTransport:
    """The real transport. One pooled client, reused across calls.

    Pooling matters at ingest: a corpus pass is one call per photograph, and a fresh TLS
    handshake per photograph is latency paid for nothing.
    """

    def __init__(self, *, client: Any | None = None) -> None:
        if client is None:
            import httpx  # imported lazily so tests never need the dependency loaded

            client = httpx.Client(follow_redirects=False)
        self._client = client

    def close(self) -> None:
        close = getattr(self._client, "close", None)
        if callable(close):
            close()

    def __enter__(self) -> HttpxTransport:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _wrap(self, response: Any) -> HttpResponse:
        return HttpResponse(
            status_code=int(response.status_code),
            text=response.text,
            headers={k.lower(): v for k, v in response.headers.items()},
        )

    def post_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout: float,
    ) -> HttpResponse:
        try:
            return self._wrap(
                self._client.post(url, headers=dict(headers), json=dict(payload), timeout=timeout)
            )
        # Every httpx failure mode is collapsed into one type: the caller's decision is
        # the same for a timeout, a DNS failure and a reset connection.
        except Exception as exc:
            raise TransportError(f"POST {url} failed: {exc!r}") from exc

    def get_json(
        self, url: str, *, headers: Mapping[str, str], timeout: float
    ) -> HttpResponse:
        try:
            return self._wrap(self._client.get(url, headers=dict(headers), timeout=timeout))
        except Exception as exc:
            raise TransportError(f"GET {url} failed: {exc!r}") from exc

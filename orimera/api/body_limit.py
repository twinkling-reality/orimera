"""Refuse an over-large request body before any of it is read.

**Why this is middleware and not a check in a route.** A route function runs after the body has
been received: FastAPI reads and parses it, then resolves dependencies, then calls the handler.
By the time an upload route could look at the size, a multipart parser has already spooled every
part to a temporary file. A check there bounds what reaches the store, which matters and is
where the intake route does it, and it does not bound the disk. This runs before the application
sees the request at all, so an over-large body is refused with nothing written anywhere.

**What it does not cover, stated rather than implied.** It reads ``Content-Length``. A request
sent with ``Transfer-Encoding: chunked`` declares no length, and this lets it through: the honest
bound for that case is a body-size limit on whatever terminates TLS in front of the application,
which is a deployment setting rather than a thing an ASGI app can enforce without counting bytes
it has already accepted. ``docs/deployment.md`` says so beside the other things a proxy owns.

It applies to every route rather than to the upload route alone, deliberately. A limit that has
to be remembered per route is a limit the next route will not have.
"""

from __future__ import annotations

import json
from typing import Any, Final

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

__all__ = ["MAX_BODY_BYTES", "BodyLimit"]

#: The largest request body this application will accept. Large enough for a phone's worth of
#: photographs in one upload, small enough that a mistaken video does not fill a disk.
MAX_BODY_BYTES: Final = 512 * 1024 * 1024


class BodyLimit:
    """Pure ASGI, so it runs ahead of routing and ahead of any body parsing."""

    def __init__(self, app: ASGIApp, *, limit: int = MAX_BODY_BYTES) -> None:
        self._app = app
        self._limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        declared = _declared_length(scope)
        if declared is not None and declared > self._limit:
            await _refuse(send, declared, self._limit)
            return
        await self._app(scope, receive, send)


def _declared_length(scope: Scope) -> int | None:
    """The declared body size, or None when the client declared none or declared nonsense.

    A malformed ``Content-Length`` is None rather than zero and rather than an error. It is a
    header this middleware only reads to refuse on, so an unreadable one means "no grounds to
    refuse here"; the request is then handled by whatever else would have handled it.
    """
    raw = Headers(scope=scope).get("content-length")
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


async def _refuse(send: Send, declared: int, limit: int) -> None:
    """The same problem shape every other refusal in this API uses."""
    body: dict[str, Any] = {
        "code": "body_too_large",
        "detail": (
            f"the request declares {declared} bytes and this instance accepts at most {limit}"
        ),
    }
    payload = json.dumps(body).encode("utf-8")
    start: Message = {
        "type": "http.response.start",
        "status": 413,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(payload)).encode("ascii")),
            # The connection is closed rather than drained. Reading a body only to discard it is
            # doing the work the refusal exists to avoid.
            (b"connection", b"close"),
        ],
    }
    await send(start)
    await send({"type": "http.response.body", "body": payload})

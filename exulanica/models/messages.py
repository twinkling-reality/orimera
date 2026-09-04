"""Content parts for a chat message.

Two functions, and the second one is where a real decision is recorded. The corpus is private
photographs, so an image reaches the endpoint as bytes rather than as a URL the provider would
have to fetch, and the base64 overhead is the price of not publishing a photograph at a
reachable address to have it described.
"""

from __future__ import annotations

import base64
from typing import Any

__all__ = ["image_part", "text_part"]


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

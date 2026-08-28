"""Generated test photographs, a vision model that counts its calls, and the model-client fakes.

Images are generated rather than committed. The repository carries no binary fixture, the
content of every test image is known exactly, and an orientation test can assert on a specific
pixel rather than on a hash somebody once recorded.

Nothing in this directory reaches the network or spends credits. The model client is driven
through ``model_fakes.FakeTransport``, which is the real client running against a scripted
transport rather than a mock of the client.
"""

from __future__ import annotations

import datetime as dt
import io
import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from orimera.ingest.vision import VisionObservation, VisionResult
from orimera.models.budget import BudgetGuard
from orimera.models.client import ModelClient
from orimera.models.manifest import load_manifest
from PIL import Image
from PIL.TiffImagePlugin import IFDRational

from model_fakes import FakeTransport

#: Explicit rather than environment-derived, so a developer's exported ORIMERA_BUDGET_USD cannot
#: change what a test asserts.
TEST_CEILING_USD = Decimal("5.00")
TEST_MAX_CALLS = 1000

#: A distinctive, asymmetric layout. The red block sits in the top-left of the UPRIGHT image,
#: which is what makes "was orientation applied" a pixel check rather than a metadata check.
RED = (220, 30, 30)
BLUE = (30, 60, 220)
WHITE = (255, 255, 255)


def upright_pixels(width: int = 160, height: int = 100) -> Image.Image:
    """A landscape image: red block top-left, blue bar along the bottom, white elsewhere."""
    image = Image.new("RGB", (width, height), WHITE)
    pixels = image.load()
    assert pixels is not None
    for y in range(height):
        for x in range(width):
            if x < width // 3 and y < height // 3:
                pixels[x, y] = RED
            elif y > height - height // 6:
                pixels[x, y] = BLUE
    return image


_INVERSE_TRANSFORM = {
    1: None,
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_90,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_270,
}


def photo_bytes(
    *,
    orientation: int = 1,
    when: str | None = "2026:08:27 10:00:00",
    offset: str | None = "+00:00",
    gps: tuple[float, float] | None = None,
    make: str | None = "Orimera",
    model: str | None = "TestCam 1",
    size: tuple[int, int] = (160, 100),
) -> bytes:
    """A JPEG whose stored pixels need ``orientation`` applied to look like ``upright_pixels``.

    The stored pixels are the inverse of the display transform, exactly as a camera writes
    them: sensor readout plus a tag saying how to display it.
    """
    image = upright_pixels(*size)
    inverse = _INVERSE_TRANSFORM[orientation]
    stored = image.transpose(inverse) if inverse is not None else image

    exif = Image.Exif()
    exif[0x0112] = orientation
    if make:
        exif[0x010F] = make
    if model:
        exif[0x0110] = model
    if when:
        exif.get_ifd(0x8769)[0x9003] = when
        if offset:
            exif.get_ifd(0x8769)[0x9011] = offset
    if gps is not None:
        latitude, longitude = gps
        gps_ifd = exif.get_ifd(0x8825)
        gps_ifd[1] = "N" if latitude >= 0 else "S"
        gps_ifd[2] = _dms(abs(latitude))
        gps_ifd[3] = "E" if longitude >= 0 else "W"
        gps_ifd[4] = _dms(abs(longitude))

    buffer = io.BytesIO()
    stored.save(buffer, format="JPEG", quality=95, exif=exif)
    return buffer.getvalue()


def _dms(value: float) -> tuple[IFDRational, IFDRational, IFDRational]:
    degrees = int(value)
    minutes_full = (value - degrees) * 60
    minutes = int(minutes_full)
    seconds = round((minutes_full - minutes) * 60 * 1000)
    return (
        IFDRational(degrees, 1),
        IFDRational(minutes, 1),
        IFDRational(seconds, 1000),
    )


def write_photo(directory: Path, name: str, **kwargs: Any) -> Path:
    path = directory / name
    path.write_bytes(photo_bytes(**kwargs))
    return path


DEFAULT_PAYLOAD: dict[str, Any] = {
    "scene_description": "A red block above a blue bar, photographed head on.",
    "objects": [
        {
            "label": "red block",
            "salience": "primary",
            "confidence": "high",
            "box": {"x": 0.0, "y": 0.0, "w": 0.33, "h": 0.33},
        },
        {"label": "person", "salience": "background", "confidence": "low", "box": None},
    ],
    "legible_text": [
        {
            "text": "GULLFOSS 2 KM",
            "is_signage": True,
            "confidence": "medium",
            "box": {"x": 0.4, "y": 0.5, "w": 0.2, "h": 0.1},
        }
    ],
    "proposed_place": {
        "label": "Gullfoss",
        "basis": "signage",
        "supporting_evidence": "A sign reading GULLFOSS 2 KM.",
        "confidence": "medium",
    },
}


@dataclass
class CountingVisionModel:
    """A vision model that never touches the network and remembers every call.

    The idempotency test is only worth something if a second model call is impossible to miss,
    so the count lives here rather than being inferred from token totals.
    """

    payload: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_PAYLOAD))
    calls: int = 0
    images: list[bytes] = field(default_factory=list)
    model_id: str = "MiniMaxAI/MiniMax-M3"

    def observe(self, *, image_bytes: bytes, media_type: str) -> VisionResult:
        self.calls += 1
        self.images.append(image_bytes)
        payload = dict(self.payload)
        return VisionResult(
            observation=VisionObservation.model_validate(payload),
            payload=payload,
            model_id=self.model_id,
            model_ref={"provider": "test", "model_id": self.model_id, "endpoint": "test"},
            cost={"input_tokens": 772, "output_tokens": 210, "usd_estimate": "0.00048780"},
            attempts=1,
            tried=(self.model_id,),
            latency_ms=12,
        )


@pytest.fixture
def workspace_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def photo_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "photos"
    directory.mkdir()
    return directory


def iso(hour: int, minute: int = 0, day: int = 27) -> str:
    return dt.datetime(2026, 8, day, hour, minute, tzinfo=dt.UTC).strftime("%Y:%m:%d %H:%M:%S")


# ---------------------------------------------------------------------------------------
# The model client. Fixtures only; the fakes themselves live in tests/model_fakes.py.
# ---------------------------------------------------------------------------------------


@pytest.fixture
def manifest():
    return load_manifest()


@pytest.fixture
def transport() -> FakeTransport:
    return FakeTransport()


@pytest.fixture
def guard() -> BudgetGuard:
    return BudgetGuard(ceiling_usd=TEST_CEILING_USD, max_calls=TEST_MAX_CALLS)


@pytest.fixture
def client(manifest, transport) -> ModelClient:
    """The real client over a scripted transport, with an explicit budget and no cache.

    ``api_key`` is passed so the fixture never reads the developer's ``.env``. Retries are off,
    which is the library default: a test that wants them says so.
    """
    return ModelClient(
        api_key="test-key-not-real",
        manifest=manifest,
        transport=transport,
        budget=BudgetGuard(ceiling_usd=TEST_CEILING_USD, max_calls=TEST_MAX_CALLS),
    )


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    """Say loudly when the epistemic guard tests did not run.

    A green summary that omits them is the exact failure this codebase already shipped once: a
    test that passes without exercising its case. Silence here would be the same mistake at the
    level of the suite.
    """
    import os

    if os.environ.get("ORIMERA_TEST_DATABASE_URL"):
        return
    skipped = [
        r
        for r in terminalreporter.stats.get("skipped", [])
        if "pg_harness" in str(r.longrepr) or "postgres" in str(getattr(r, "nodeid", ""))
    ]
    if not skipped:
        return
    terminalreporter.write_sep("=", "UNVERIFIED INVARIANT", red=True, bold=True)
    terminalreporter.write_line(
        f"{len(skipped)} PostgreSQL tests were skipped. These are the only executable proof that a "
        "model cannot write a name into canonical state (invariant 4)."
    )
    terminalreporter.write_line(
        "Run them with:  ORIMERA_TEST_DATABASE_URL=postgresql:///orimera_spine_test uv run pytest"
    )

"""The one place a photograph becomes pixels, and the pixel budget that applies when it does.

Two settings here are **interpreter-global**, which is the whole reason this module exists
rather than the two lines living wherever an image is next opened:

*   ``Image.MAX_IMAGE_PIXELS`` is a module attribute on ``PIL.Image``. Setting it twice with two
    different numbers means the effective limit is whichever module was imported last, which is
    a limit nobody chose.
*   ``warnings.simplefilter`` mutates the process-wide warning filters. Pillow *raises*
    ``DecompressionBombError`` only past **twice** the limit and merely *warns* between one and
    two times it, so without promoting that warning a file at 1.5x the budget decodes in full
    and a line appears on stderr that no request ever sees.

**The explicit size check below is not redundant with that filter**, and this is the whole
reason it is written out. Warning filters are process state that anything may reset:
``warnings.resetwarnings()``, a ``-W`` flag, a test runner configuring its own filters, a
library being helpful. Any of those silently removes the promotion, and the symptom is not an
error, it is a large file quietly decoded. So the budget is enforced by comparing two integers,
which nothing can reset, and the filter stays because it is what makes Pillow's own message the
one a caller sees when it fires first. ``tests/test_intake_upload.py`` resets the filters and
feeds a bomb, so the claim is checked rather than asserted.

**The budget is deliberately below Pillow's default.** 89478485 pixels is roughly 8000x11000
and costs about 1 GB of RSS to decode as RGB. :data:`MAX_PIXELS` is the largest frame this
pipeline expects to see with room to spare, and a photograph over it is refused with the pixel
count in the message rather than decoded.

**What this does not bound.** The number of bytes. A file can be small and decode enormous,
which is what a decompression bomb is, and it can be enormous and decode to nothing. The byte
bound belongs to whoever is reading the bytes: the upload route bounds a part, and the command
line reads files a person chose off their own disk.
"""

from __future__ import annotations

import io
import warnings
from typing import Final

from PIL import Image, UnidentifiedImageError

from orimera.ingest.exif import ExifFacts, extract_exif_facts

__all__ = ["MAX_PIXELS", "UNREADABLE", "open_upright", "probe"]

#: The largest frame this pipeline will decode, in pixels. 12000 x 12000 is well past any
#: consumer camera and well under the memory a machine serving requests can spare.
MAX_PIXELS: Final = 144_000_000

Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)

#: Everything that means "these bytes are not a photograph this pipeline can read".
#:
#: ``DecompressionBombError`` is in here because it is neither ``UnidentifiedImageError`` nor
#: ``OSError``: it derives straight from ``Exception``, so a handler catching the other two lets
#: it past and the refusal arrives as an unclassified failure with no pixel count in it.
#: ``DecompressionBombWarning`` is here because the filter above turns it into a raise, and a
#: warning promoted to an error is not an ``OSError`` either.
UNREADABLE: Final = (
    UnidentifiedImageError,
    Image.DecompressionBombError,
    Image.DecompressionBombWarning,
    OSError,
)


def probe(data: bytes) -> tuple[int, int]:
    """The frame's dimensions from its header alone, or a refusal. No decode.

    What an upload route needs and all it needs: whether these bytes are an image of a format
    this pipeline reads, and whether the frame is inside the budget. Both answers come out of
    the header, so a photograph too large to decode is refused for the price of parsing one,
    and the one decode that does happen happens once, later, in the pipeline.
    """
    with Image.open(io.BytesIO(data)) as opened:
        return _within_budget(opened)


def open_upright(data: bytes) -> tuple[Image.Image, ExifFacts]:
    """Decode these bytes and return the upright image and everything the file itself says.

    Raises one of :data:`UNREADABLE` for anything that is not a readable photograph. The caller
    decides what a refusal means; this decides only what a photograph is.

    The size is read from the header and compared before ``load()``, so a frame over the budget
    costs a header parse rather than a decode. ``load()`` is called inside the ``with`` so the
    pixel data is in memory before the file object closes, and the orientation transform happens
    exactly once, here, so no later stage repeats the decision or works from the wrong rotation.
    """
    with Image.open(io.BytesIO(data)) as opened:
        _within_budget(opened)
        opened.load()
        return extract_exif_facts(opened)


def _within_budget(image: Image.Image) -> tuple[int, int]:
    """The one comparison that enforces :data:`MAX_PIXELS`. Returns the size when it passes."""
    width, height = image.size
    pixels = width * height
    if pixels > MAX_PIXELS:
        raise Image.DecompressionBombError(
            f"image size ({width}x{height} = {pixels} pixels) exceeds this pipeline's limit "
            f"of {MAX_PIXELS} pixels"
        )
    return width, height

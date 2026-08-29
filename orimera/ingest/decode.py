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

**The budget is below Pillow's default, and the direction matters.** Assigning
``Image.MAX_IMAGE_PIXELS`` raises or lowers Pillow's own ceiling process-wide, so a number above
its default silently makes every caller in the process more permissive than Pillow intended,
including the corpus renderer and the command line. 89478485 is Pillow's default;
:data:`MAX_PIXELS` is below it.

**The number is an arithmetic about memory, not a claim about cameras.** Pillow decodes to a
byte per channel, so a frame costs `3 x pixels` as RGB, and the orientation transform in
``extract_exif_facts`` allocates a second buffer of the same size. At 64 megapixels that is
about 192 MB decoded and about 384 MB at peak, in a request thread. A larger frame, a stitched
panorama or a medium-format original, is refused with its own pixel count in the message and the
number here is one line to raise deliberately.

**What is NOT bounded, said plainly.** This bounds one decode. A synchronous route runs in the
ASGI server's threadpool, so the aggregate is that bound times the number of threads, and
nothing here limits how many decode at once. Bounding that means a semaphore and a decision
about how many concurrent uploads an instance serves, which is a deployment's to make.

**And it does not bound the number of bytes.** A file can be small and decode enormous, which is
what a decompression bomb is, and it can be enormous and decode to nothing. The byte bound
belongs to whoever is reading the bytes: the upload route bounds a part, and the command line
reads files a person chose off their own disk.
"""

from __future__ import annotations

import io
import warnings
from typing import Final

from PIL import Image, UnidentifiedImageError

from orimera.ingest.exif import ExifFacts, extract_exif_facts

__all__ = ["MAX_PIXELS", "UNREADABLE", "open_upright", "probe"]

#: The largest frame this pipeline will decode, in pixels. 64 megapixels: past every phone and
#: every consumer camera, below Pillow's own 89478485 default so that assigning it below tightens
#: rather than loosens, and about 384 MB at peak to decode and turn upright.
MAX_PIXELS: Final = 64_000_000

Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)

#: Everything that means "these bytes are not a photograph this pipeline can read".
#:
#: ``DecompressionBombError`` is in here because it is neither ``UnidentifiedImageError`` nor
#: ``OSError``: it derives straight from ``Exception``, so a handler catching the other two lets
#: it past and the refusal arrives as an unclassified failure with no pixel count in it.
#: ``DecompressionBombWarning`` is here because the filter above turns it into a raise, and a
#: warning promoted to an error is not an ``OSError`` either.
#:
#: ``ValueError`` is here because **Pillow dispatches on magic bytes, not on the file name**, so
#: bytes named ``a.jpg`` reach whichever plugin their first bytes match, and a plugin failing on
#: its own header does not raise ``UnidentifiedImageError``. Measured: a thirty-byte part named
#: ``a.jpg`` beginning ``P6\n99999999999999999999 1\n255\n`` reaches ``PpmImagePlugin`` and
#: raises ``ValueError: Token too long in file header``. That is still "these bytes are not a
#: photograph", and a handler that let it past turned a refusal into a 500.
UNREADABLE: Final = (
    UnidentifiedImageError,
    Image.DecompressionBombError,
    Image.DecompressionBombWarning,
    OSError,
    ValueError,
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

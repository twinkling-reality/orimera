"""Content addressing of original bytes.

**Algorithm: SHA-256.** Chosen over BLAKE3, which is several times faster, for three reasons
that all outlive the speed difference:

*   RFC 6920 "Naming Things with Hashes" gives ``sha-256`` a registered name and a canonical
    URI form, ``ni:///sha-256;<base64url-digest>``, with ``sha-256`` as the mandatory-to-
    implement algorithm. A citation address has to remain parseable by software that does not
    exist yet, and a registered identifier is what makes that possible.
*   C2PA hard bindings use SHA-256, so a future device-signed provenance path lines up without
    a second hash of the same bytes.
*   PostgreSQL computes it in ``pgcrypto``, so the database can verify a key rather than trust
    the application's word for it.

Hashing speed is not the bottleneck for a one-shot ingest hash, and the corpus is photographs.

The digest is stored raw (32 bytes, ``bytea``) and rendered in ``ni`` form for display and for
the address URI. The base64url encoding is unpadded, matching RFC 6920 and matching the
generated column in migration 0001, which strips ``=`` via ``translate``.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Final

from exulanica.errors import InvalidAddressError

__all__ = ["DIGEST_BYTES", "HASH_ALGORITHM", "NI_PREFIX", "BlobId"]

HASH_ALGORITHM: Final = "sha-256"
DIGEST_BYTES: Final = 32
NI_PREFIX: Final = f"ni:///{HASH_ALGORITHM};"

# 32 bytes base64url-encode to 43 characters with no padding.
_NI_RE: Final = re.compile(r"^ni:///sha-256;([A-Za-z0-9_-]{43})$")
_HEX_RE: Final = re.compile(r"^[0-9a-f]{64}$")

# 1 MiB. Large enough that syscall overhead is irrelevant, small enough to stream a video
# without holding it in memory.
_CHUNK: Final = 1 << 20


@dataclass(frozen=True, slots=True, order=True)
class BlobId:
    """The identity of an ingested byte sequence: SHA-256 of the original bytes.

    Equality and ordering are over the raw digest, so a sorted list of blob ids is stable
    across processes and across languages. Ordering exists so that digest inputs built from
    sets of blobs (an artifact's ``input_digest``, for example) have one canonical order.
    """

    digest: bytes

    def __post_init__(self) -> None:
        if not isinstance(self.digest, bytes) or len(self.digest) != DIGEST_BYTES:
            described = (
                f"{len(self.digest)} bytes"
                if isinstance(self.digest, bytes | bytearray)
                else type(self.digest).__name__
            )
            raise InvalidAddressError(f"blob id must be {DIGEST_BYTES} raw bytes, got {described}")

    # -- construction ----------------------------------------------------------------

    @classmethod
    def of_bytes(cls, data: bytes) -> BlobId:
        """Hash an in-memory byte sequence."""
        return cls(hashlib.sha256(data).digest())

    @classmethod
    def of_stream(cls, stream: IO[bytes]) -> BlobId:
        """Hash a readable binary stream without holding it in memory.

        The stream is read from its current position to EOF and is not rewound afterwards.
        """
        hasher = hashlib.sha256()
        while chunk := stream.read(_CHUNK):
            hasher.update(chunk)
        return cls(hasher.digest())

    @classmethod
    def of_file(cls, path: str | os.PathLike[str]) -> BlobId:
        """Hash a file on disk by streaming it."""
        with Path(path).open("rb") as handle:
            return cls.of_stream(handle)

    @classmethod
    def from_hex(cls, value: str) -> BlobId:
        """Parse the lowercase hex form used in logs and job keys."""
        if not _HEX_RE.match(value):
            raise InvalidAddressError(f"not a lowercase sha-256 hex digest: {value!r}")
        return cls(bytes.fromhex(value))

    @classmethod
    def from_ni_uri(cls, value: str) -> BlobId:
        """Parse the RFC 6920 ``ni:///sha-256;<base64url>`` form."""
        match = _NI_RE.match(value)
        if match is None:
            raise InvalidAddressError(f"not an RFC 6920 sha-256 ni URI: {value!r}")
        return cls(base64.urlsafe_b64decode(match.group(1) + "="))

    # -- rendering -------------------------------------------------------------------

    @property
    def hex(self) -> str:
        """Lowercase hex, 64 characters."""
        return self.digest.hex()

    @property
    def b64url(self) -> str:
        """Unpadded base64url, 43 characters. The body of the ni URI."""
        return base64.urlsafe_b64encode(self.digest).decode("ascii").rstrip("=")

    @property
    def ni_uri(self) -> str:
        """RFC 6920 canonical form. This is what appears inside a citation URI."""
        return NI_PREFIX + self.b64url

    def __str__(self) -> str:
        return self.ni_uri

    def __repr__(self) -> str:
        return f"BlobId({self.hex[:12]}...)"

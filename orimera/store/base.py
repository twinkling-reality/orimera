"""The content-addressed store interface.

Two properties are structural rather than documented, because a documented property is one an
injected instruction or a tired afternoon can talk past:

1.  **The normal interface has no delete.** ``ContentAddressedStore`` exposes ``put``, ``get``,
    ``open``, ``exists`` and ``size``. There is no ``delete``, no ``purge`` and no ``clear``, so
    a caller holding a store cannot destroy anything, whatever it is asked to do.
2.  **Erasure is a separate, explicitly authorised operation.** It is reached only through
    ``privileged_purger(store, authorization)``, and a ``PurgeAuthorization`` cannot be
    constructed without a tombstone id, an actor and a reason. Deletion is real, and it is not
    on the request path.

This asymmetry is deliberate and it is the same one the object-storage design takes: the runtime
service account can write and read but is denied ``DeleteObject`` and ``DeleteObjectVersion`` by
bucket policy, and a user's deletion runs through a separate privileged path. Say "append-only
by policy". Never "immutable", "WORM" or "tamper-proof": the platform supports no Object Lock,
no Legal Hold and no write-once-read-many retention, so those words would be an overclaim.

The interface is written so that an S3-compatible backend satisfies it without changing a
caller: ``key_for`` returns an object key, ``put`` is idempotent under content addressing, and
nothing exposes a filesystem path.
"""

from __future__ import annotations

import abc
import os
from collections.abc import Iterator
from dataclasses import dataclass
from typing import IO

from orimera.errors import PurgeNotAuthorisedError
from orimera.evidence.blob import BlobId

__all__ = [
    "ContentAddressedStore",
    "PrivilegedPurger",
    "PurgeAuthorization",
    "PutResult",
    "privileged_purger",
]


@dataclass(frozen=True, slots=True)
class PutResult:
    """What a write did.

    ``created`` is False when the identical bytes were already present, which under content
    addressing is the normal deduplication case: re-uploading the same photograph costs one
    hash and no storage, and every derivative of those bytes is already computed.
    """

    blob_id: BlobId
    byte_size: int
    created: bool


class ContentAddressedStore(abc.ABC):
    """Read and write original bytes under content-addressed keys.

    Implementations must never overwrite an existing key with different content. Under content
    addressing that situation can only mean a SHA-256 collision or a corrupted store, and
    neither is something to silently absorb.
    """

    @abc.abstractmethod
    def key_for(self, blob_id: BlobId) -> str:
        """The backend key for a blob. Stable, and identical across backends."""

    @abc.abstractmethod
    def put_bytes(self, data: bytes) -> PutResult:
        """Store an in-memory byte sequence under its own hash."""

    @abc.abstractmethod
    def put_stream(self, stream: IO[bytes]) -> PutResult:
        """Store a readable binary stream without holding it in memory."""

    @abc.abstractmethod
    def put_file(self, path: str | os.PathLike[str]) -> PutResult:
        """Store a file from disk by streaming it."""

    @abc.abstractmethod
    def get(self, blob_id: BlobId) -> bytes:
        """Read a whole blob, verifying that the bytes still hash to the key."""

    @abc.abstractmethod
    def open(self, blob_id: BlobId) -> IO[bytes]:
        """Open a blob for streaming reads.

        The caller gets the bytes without an integrity check, because verifying a stream means
        buffering it. Use ``get`` when the check matters and the object fits in memory.
        """

    @abc.abstractmethod
    def exists(self, blob_id: BlobId) -> bool: ...

    @abc.abstractmethod
    def size(self, blob_id: BlobId) -> int: ...

    @abc.abstractmethod
    def iter_blob_ids(self) -> Iterator[BlobId]:
        """Enumerate stored blobs. Used by reconciliation and by tests, not by the query path."""


@dataclass(frozen=True, slots=True)
class PurgeAuthorization:
    """Proof that a purge was requested by a tombstone rather than by a code path.

    Every field is mandatory. The type exists so that "delete these bytes" cannot be expressed
    without naming the tombstone that authorises it, which is what makes the purge auditable
    against the ledger afterwards.
    """

    tombstone_id: str
    actor: str
    reason: str

    def __post_init__(self) -> None:
        for name in ("tombstone_id", "actor", "reason"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise PurgeNotAuthorisedError(
                    f"purge authorisation requires a non-empty {name}; erasure is never implicit"
                )


class PrivilegedPurger(abc.ABC):
    """The separate, privileged erasure path. Obtained only via ``privileged_purger``."""

    @abc.abstractmethod
    def purge(self, blob_id: BlobId) -> bool:
        """Destroy the bytes for one blob. Returns False when they were already absent.

        Purging is idempotent so that a crashed purge job resumes rather than failing. The
        caller is responsible for the row-level tombstone; this only removes bytes.
        """


def privileged_purger(
    store: ContentAddressedStore, authorization: PurgeAuthorization
) -> PrivilegedPurger:
    """Escalate a store to an erasure-capable object, given an explicit authorisation.

    Implemented as a free function rather than a method so that a ``ContentAddressedStore``
    value never carries the capability. Backends opt in by implementing ``_privileged_purger``;
    a backend that has not is refused rather than silently no-oping.
    """
    if not isinstance(authorization, PurgeAuthorization):
        raise PurgeNotAuthorisedError(
            "privileged_purger requires a PurgeAuthorization naming the tombstone, the actor "
            "and the reason"
        )
    factory = getattr(store, "_privileged_purger", None)
    if factory is None:
        raise PurgeNotAuthorisedError(f"{type(store).__name__} exposes no privileged erasure path")
    return factory(authorization)

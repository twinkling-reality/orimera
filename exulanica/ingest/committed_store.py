"""The one ordering boundary between database facts and object-store bytes."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from orimera.ingest.repository import IngestRepository
from orimera.store import ContentAddressedStore

__all__ = ["committed_writes"]


@contextmanager
def committed_writes(
    repository: IngestRepository, store: ContentAddressedStore
) -> Iterator[list[bytes]]:
    """Commit guarded rows first, then flush exactly the bytes those rows name.

    A store write cannot join the database transaction. Writing before commit can resurrect
    content when a tombstone refuses the rows, while writing after commit leaves a missing object
    that a deterministic retry can safely heal. Every ingest-owned object write passes through
    this function so that ordering remains structural rather than a caller convention.
    """
    pending: list[bytes] = []
    with repository.transaction():
        yield pending
    for payload in pending:
        store.put_bytes(payload)

"""The registry of exact bytes, and the lock that keeps an ingest out of a purge.

``blob`` is keyed on the content hash and has no ``workspace_id``: the same photograph imported
by two people is one row and one stored object. That is what makes the lock below necessary
rather than tidy, because it is also what makes a purge for one workspace destroy bytes another
is using.
"""

from __future__ import annotations

from orimera.evidence.blob import BlobId
from orimera.ingest.spine.scope import WorkspaceScope

__all__ = ["lock_stored_object", "upsert"]


def lock_stored_object(scope: WorkspaceScope, blob_id: BlobId) -> None:
    """Take the transaction lock over one stored object, keyed on its content hash.

    The same lock ``orimera.deletion`` takes before it asks whether an object may be destroyed
    and then destroys it. Both sides have to take it or neither is serialised: with only the
    purger taking it, a purger and an ingest can interleave so that the ingest commits a live
    capture for bytes the purger is in the middle of removing, and under content addressing that
    ingest writes nothing to the store because the object was already there. Measured; migration
    0015's sibling comment in ``orimera/ingest/stages/intake.py`` has the observed sequence.

    Named for what it locks rather than for who else takes it. The SQL function is called
    ``purge_lock_object`` because the purger is where it was first needed; renaming a shipped
    function would be a migration for a word.
    """
    scope.connection.execute("select purge_lock_object(%s)", (blob_id.hex,))


def upsert(
    scope: WorkspaceScope, blob_id: BlobId, *, byte_size: int, media_type: str, storage_key: str
) -> bool:
    """Register bytes. Returns True when the database had not seen them before."""
    cursor = scope.connection.execute(
        "insert into blob (blob_sha256, byte_size, media_type, storage_key) "
        "values (%s, %s, %s, %s) on conflict (blob_sha256) do nothing",
        (blob_id.digest, byte_size, media_type, storage_key),
    )
    return cursor.rowcount > 0

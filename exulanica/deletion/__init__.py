"""Erasure: the queue a tombstone fills, and the worker that empties it.

**Below the three workflow layers, so ``exulanica.ingest`` may import it.** That is what lets
``insert_tombstone`` stay singular rather than being reimplemented once per caller, and it is
why this is a package of its own rather than a module inside ingest: ingest writes tombstones and
must not own deletion.

**Nothing here can destroy anything on its own.** The store has no delete. Erasure is reached
only through :func:`exulanica.store.privileged_purger`, which takes a
:class:`~exulanica.store.base.PurgeAuthorization` that cannot be constructed without naming the
tombstone, the actor and the reason. This package supplies those from a real tombstone row; it
does not invent them.

**And it never deletes a database row.** It marks ``purged_at`` and clears ``storage_key``, which
is what 0001's ``blob`` stub is for: the hash survives the bytes, so a citation into deleted
content resolves to "the user deleted this" rather than to nothing at all. The purge role holds
no DELETE on any table, which is checked rather than intended.

Read :mod:`exulanica.deletion.queue` for what a job is and
:mod:`exulanica.deletion.worker` for the order the destruction happens in, which is the part that
has to be right.
"""

from __future__ import annotations

from exulanica.deletion.queue import PurgeTarget, claim_purge, finish_purge, is_purge_complete
from exulanica.deletion.worker import PurgeOutcome, PurgeWorker

__all__ = [
    "PurgeOutcome",
    "PurgeTarget",
    "PurgeWorker",
    "claim_purge",
    "finish_purge",
    "is_purge_complete",
]

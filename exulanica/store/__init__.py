"""Content-addressed storage for original bytes.

The normal interface cannot delete. Erasure exists, is real, and is reached only through
``privileged_purger`` with an explicit ``PurgeAuthorization``.
"""

from __future__ import annotations

from exulanica.store.base import (
    ContentAddressedStore,
    PrivilegedPurger,
    PurgeAuthorization,
    PutResult,
    privileged_purger,
)
from exulanica.store.local import LocalContentAddressedStore

__all__ = [
    "ContentAddressedStore",
    "LocalContentAddressedStore",
    "PrivilegedPurger",
    "PurgeAuthorization",
    "PutResult",
    "privileged_purger",
]

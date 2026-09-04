"""Error types shared across the evidence spine and the content-addressed store.

Errors are separate classes rather than bare ValueError because several of them are
control-flow relevant: a worker treats TombstonedError as terminal, and the store treats
IntegrityError as a hard stop rather than a retry.
"""

from __future__ import annotations


class OrimeraError(Exception):
    """Base class for every error raised by this package."""


class InvalidAddressError(OrimeraError, ValueError):
    """An evidence address, or a component of one, is not well formed."""


class LossyAddressError(OrimeraError):
    """Rendering this address to a URI would drop an input to its span digest.

    Raised rather than silently emitting a citation string that cannot be verified against
    the digest it claims to name. Pass allow_lossy=True to accept the loss explicitly.
    """


class CanonicalisationError(OrimeraError, TypeError):
    """A value cannot be canonicalised deterministically, so it may not enter a digest."""


class IntegrityError(OrimeraError):
    """Stored bytes do not hash to the key they are stored under."""


class BlobNotFoundError(OrimeraError, KeyError):
    """No object exists in the store for this blob id."""


class ImmutableKeyError(OrimeraError):
    """A write would change the content already stored at a content-addressed key.

    Under content addressing this can only mean a hash collision or a corrupted store, so it
    is never absorbed as an overwrite.
    """


class PurgeNotAuthorisedError(OrimeraError):
    """A purge was attempted without a well formed authorisation."""


class EpistemicViolation(OrimeraError):
    """A write would file a claim under a provenance class its predicate does not allow.

    The database refuses the same write with an SQLSTATE and no explanation. This carries the
    explanation: which predicate, which kind, and which kinds it does allow.
    """


class TombstonedError(OrimeraError):
    """A committed tombstone covers this address. Terminal, never retried.

    Control-flow relevant, and this is the one that costs something when it is wrong. A worker
    cancels on this and retries on anything else, so a tombstone refusal that arrives as some
    other error type becomes an unbounded retry loop against content the user deleted.
    """

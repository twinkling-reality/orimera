"""Turning the schema's write guards back into the errors callers reason about.

The guards in migrations 0001 and 0002 are triggers, and a trigger can raise nothing but an
SQLSTATE with a message. That is the right place for them: a trigger fires inside the writing
transaction, on every route into the table, including routes that never come through this
package. What it costs is the error type, and for one of these the type is load-bearing.

``TombstonedError`` is the one that matters. A worker cancels on it and retries on anything
else, so a tombstone refusal arriving as a generic database error becomes an unbounded retry
loop against content the user asked to have deleted. That is not a cosmetic difference: it is
the difference between a deletion that holds and one that a scheduler defeats.

The refusal is identified by its message rather than by its SQLSTATE alone, and deliberately.
``tombstone_refuse()`` and ``tg_assertion_kind_is_allowed()`` both raise
``integrity_constraint_violation``, and to a caller deciding whether to retry, "the user deleted
this" and "a model tried to write a name" are not interchangeable.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

import psycopg

from exulanica.errors import TombstonedError

__all__ = ["TOMBSTONE_REFUSAL", "terminal_if_tombstoned"]

#: The exact wording ``tombstone_refuse()`` raises. Changing it in the migration without
#: changing it here turns every tombstone refusal back into a retryable failure, silently, which
#: is why a test asserts the round trip rather than trusting the two to stay in step.
TOMBSTONE_REFUSAL: Final = "tombstoned: write refused"


@contextmanager
def terminal_if_tombstoned() -> Iterator[None]:
    """Wrap a write that the tombstone guards protect, and re-raise their refusal as terminal.

    Every guarded insert needs this, not just the first one. The guards are on
    ``evidence_span``, ``occurrence``, ``assertion``, ``embedding`` and ``entity_link``, and a
    real ingest reaches several of them: covering only the span write leaves the refusal a real
    corpus actually hits arriving untranslated.
    """
    try:
        yield
    except psycopg.errors.IntegrityConstraintViolation as exc:
        if TOMBSTONE_REFUSAL not in str(exc):
            raise
        raise TombstonedError(
            f"{exc}. This is terminal: the job is cancelled, not retried."
        ) from exc

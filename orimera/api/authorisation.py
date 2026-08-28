"""Who is asking, and the two things a request is never allowed to say about itself.

Every endpoint is authorised, and authorisation resolves to a
:class:`~orimera.selection.validation.Session`, which is the same type the Selection validator
takes. That is deliberate: there is one notion of "who is asking" in this system, and the query
path's rule that "authorization derived from the session only, never from anything in the plan"
is the same rule as the API's.

Two things a request body may never contain, and they are absent from every request model in
this package rather than stripped from it:

*   **A workspace id.** It comes from the token. A request that could name a workspace could
    name somebody else's.
*   **An actor.** It comes from the token. ``entity_link.decided_by`` is what makes a confirmed
    link a human decision rather than a model's, and a client-supplied actor would make that
    column say whatever the client wanted.

**What this is, stated plainly, because overstating it would be worse than not having it.** This
is bearer-token authentication against a table of tokens the operator configures out of band. It
is not an account system, there is no registration, no password, no session expiry and no
refresh. The schema has no user table and inventing one here would be inventing a product
decision. What it does provide is the property the rest of the system depends on: a request
arrives already bound to exactly one workspace, and nothing downstream can widen that.

Tokens are compared with :func:`secrets.compare_digest` against the SHA-256 of the presented
value, so the comparison is constant time and the configured secret is never held next to a
user-supplied string in a way that a timing difference could separate.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from orimera.errors import OrimeraError
from orimera.selection.validation import Session

__all__ = [
    "API_TOKENS_ENV",
    "TokenDirectory",
    "TokenNotAccepted",
    "load_token_directory",
]

#: A JSON object mapping token to ``{"workspace_id": ..., "actor": ..., "may_include_proposals":
#: bool}``. Injected at run time and never committed, per the deployment rule that "secrets are
#: not committed and are not baked into images".
API_TOKENS_ENV: Final = "ORIMERA_API_TOKENS"


class TokenNotAccepted(OrimeraError):
    """The presented credential does not name a workspace.

    One error for "no token", "unknown token" and "malformed token", because distinguishing them
    tells an unauthenticated caller which of their guesses was closer.
    """


@dataclass(frozen=True, slots=True)
class TokenDirectory:
    """The configured tokens, keyed by digest rather than by the secret itself."""

    #: sha256 hex of the token -> the session it grants.
    sessions: Mapping[str, Session]

    def __len__(self) -> int:
        return len(self.sessions)

    def session_for(self, presented: str | None) -> Session:
        """Resolve a bearer token, in constant time, or refuse.

        The loop runs over every configured token even after a match, and the comparison is
        :func:`secrets.compare_digest`, so neither the number of configured tokens nor which one
        matched is observable from how long this took.
        """
        if not presented:
            raise TokenNotAccepted("no bearer token was presented")
        digest = hashlib.sha256(presented.encode("utf-8")).hexdigest()
        found: Session | None = None
        for candidate, session in self.sessions.items():
            if secrets.compare_digest(candidate, digest):
                found = session
        if found is None:
            raise TokenNotAccepted("the presented bearer token is not configured")
        return found


def load_token_directory(environ: Mapping[str, str] | None = None) -> TokenDirectory:
    """Read the configured tokens, or raise.

    Raises rather than returning an empty directory. An API that started with no tokens would
    serve 401 to everybody, which reads as a credential problem at the client rather than as a
    deployment that forgot its own configuration.
    """
    environ = os.environ if environ is None else environ
    raw = environ.get(API_TOKENS_ENV)
    if not raw:
        raise TokenNotAccepted(
            f"{API_TOKENS_ENV} is not set. It is a JSON object mapping a bearer token to "
            '{"workspace_id": "<uuid>", "actor": "<uuid>"}. There is no default, because a '
            "default would be a credential in a repository."
        )
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise TokenNotAccepted(f"{API_TOKENS_ENV} is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict) or not parsed:
        raise TokenNotAccepted(f"{API_TOKENS_ENV} must be a non-empty JSON object")

    sessions: dict[str, Session] = {}
    for token, grant in parsed.items():
        if not isinstance(grant, dict):
            raise TokenNotAccepted(f"{API_TOKENS_ENV}: the grant for a token is not an object")
        try:
            session = Session(
                workspace_id=uuid.UUID(grant["workspace_id"]),
                actor=uuid.UUID(grant["actor"]),
                may_include_proposals=bool(grant.get("may_include_proposals", True)),
            )
        except (KeyError, ValueError, TypeError) as exc:
            raise TokenNotAccepted(
                f"{API_TOKENS_ENV}: a grant needs workspace_id and actor as uuids ({exc})"
            ) from exc
        if len(token) < 32:
            raise TokenNotAccepted(
                "a bearer token shorter than 32 characters is refused at load time rather than "
                "accepted and relied upon"
            )
        sessions[hashlib.sha256(token.encode("utf-8")).hexdigest()] = session
    return TokenDirectory(sessions=sessions)

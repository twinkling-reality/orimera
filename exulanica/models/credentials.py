"""Reading the model credential, and the rules about where it may go afterwards.

Its own module because the rule is one sentence and the sentence is the whole point: the value
is returned and never logged, never echoed into an error message, and never written into a
cache entry. A module that does one thing is a module a reader can check that claim against.
"""

from __future__ import annotations

import os
from pathlib import Path

from exulanica.models.errors import ModelError

__all__ = ["api_key_from_env"]


def api_key_from_env(env_name: str, *, dotenv: Path | None = None) -> str:
    """Read the credential from the environment, falling back to a ``.env`` file.

    The value is returned and never logged, never echoed into an error message, and never
    written into a cache entry. A ``.env`` value does not override an already-exported variable,
    so a deliberately exported key wins over a stale file.
    """
    value = os.environ.get(env_name)
    if value and value.strip():
        return value.strip()

    if dotenv is None:
        here = Path.cwd()
        for candidate in (here, *here.parents):
            probe = candidate / ".env"
            if probe.exists():
                dotenv = probe
                break
    if dotenv is not None and dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            name, _, raw = stripped.partition("=")
            if name.strip() == env_name:
                return raw.strip().strip('"').strip("'")
    raise ModelError(
        f"no credential: set {env_name} in the environment or in a .env file. "
        "Its value is never printed by this package."
    )

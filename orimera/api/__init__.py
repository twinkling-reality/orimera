"""The HTTP surface. Routes validate and delegate; nothing here decides anything.

Four surfaces, and the shape of each says what it is for:

*   ``/healthz`` and ``/readyz`` are the only unauthenticated routes in the API. A liveness probe
    that needed a credential would go red the day the credential rotated.
*   ``/selection`` is the read path. One Selection primitive, four equal entry points, and the
    routes cannot tell which one produced the plan they were handed.
*   ``/identity`` is the whole mutation surface. No request model on it has a field for who
    decided, because that comes from the token.
*   ``/evidence`` is the product's promise as an HTTP response: given an address, the exact
    original media, with range support, and a 404 rather than a 403 for anything not yours.

The application is built by :func:`orimera.api.app.create_app`, which takes its services rather
than reading globals, so a test builds an instance against a throwaway schema and a second
instance in one process is ordinary rather than surprising.
"""

from orimera.api.app import create_app
from orimera.api.authorisation import (
    API_TOKENS_ENV,
    TokenDirectory,
    TokenNotAccepted,
    load_token_directory,
)
from orimera.api.services import Services, build_services

__all__ = [
    "API_TOKENS_ENV",
    "Services",
    "TokenDirectory",
    "TokenNotAccepted",
    "build_services",
    "create_app",
    "load_token_directory",
]

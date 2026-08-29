# The image every process in this deployment runs. One image, three commands: uvicorn serves the
# API, `orimera-db` migrates and provisions, `orimera-ingest` ingests a directory. They share
# every layer, so a second image for the ingest job would be the same bytes under another name.
#
# There is no ENTRYPOINT, only a CMD. An entrypoint would make the migration one-shot and make
# the ingest job reach for `--entrypoint`, and the whole point of one image is that they do not.
#
# WHAT THIS IMAGE DOES NOT CONTAIN is the reconstruction extra. An instance without it never runs
# the depth stage, so no `reconstruction_rung_is` assertion is written and every region reports
# `rung: null`. That is NOT rung 4: rung 4 means reconstruction ran and placed too little
# (`orimera/graph/payload.py`). Every citation resolves to its original bytes either way, because
# reconstruction is never evidence. That is the ladder working as designed rather than a
# degraded build.

FROM ghcr.io/astral-sh/uv:0.9.5 AS uv

FROM python:3.11-slim-trixie AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src

# Dependencies first and the project second, so editing a source file does not re-resolve the
# closure. `--locked` rather than `--frozen`: a uv.lock that no longer matches pyproject.toml
# fails the build here, which makes the image a third place the lock is checked rather than the
# first place it is quietly ignored.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-dev --no-install-project --extra server

# The package directory is copied, and it is not optional: without it hatchling builds an empty
# wheel, uv installs that over the working one, and the image's own entry points raise
# ModuleNotFoundError at start. `tests/test_deployment.py` asserts this COPY exists.
COPY pyproject.toml uv.lock LICENSE THIRD_PARTY_NOTICES.md ./
COPY orimera ./orimera
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable --extra server

FROM python:3.11-slim-trixie AS runtime
LABEL org.opencontainers.image.source="https://github.com/twinkling-reality/orimera"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# No apt packages at all, and that is a property rather than an omission: psycopg[binary] ships
# its own libpq and Pillow ships its own image libraries, so the runtime needs nothing from
# Debian that python:3.11-slim does not already carry. Every package added here is a package
# somebody has to patch.
RUN groupadd --system --gid 10001 orimera \
 && useradd --system --uid 10001 --gid 10001 --home-dir /app --no-create-home orimera \
 && mkdir -p /app /var/lib/orimera \
 && chown orimera:orimera /app /var/lib/orimera

COPY --from=builder --chown=orimera:orimera /app/.venv /app/.venv

ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ORIMERA_DATA_DIR=/var/lib/orimera

WORKDIR /app
USER orimera
EXPOSE 8000

# LIVENESS, never readiness. `/healthz` touches no dependency; `/readyz` opens a connection and
# an object store call, and a container restarted because its database blinked is a container
# that makes an incident worse. Written in Python because this image has no curl and does not
# need one.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]

CMD ["uvicorn", "--factory", "orimera.api.app:create_app", "--host", "0.0.0.0", "--port", "8000"]

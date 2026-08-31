# Clean evaluation replay

Status: **REPLAY MECHANICS IMPLEMENTED; REAL METRIC BASELINE AND PHASE 2 GATE BLOCKED**.

`orimera-eval replay-bundle` admits only an already validated `CORPUS.json` bundle. It does not
create photographs, labels, consent evidence, partitions, or scores. It uses two explicit database
identities:

- `ORIMERA_EVALUATION_OWNER_DATABASE_URL` points to a newly created empty database and is used only
  to check emptiness, apply forward migrations, and provision one workspace partition; and
- `ORIMERA_DATABASE_URL` points to the same database as a non-owner runtime role without
  `BYPASSRLS`.

The command does not create or drop a database. It refuses `postgres`, `template0`, `template1`, a
current schema other than `public`, any non-system schema besides `public`, or any pre-existing user
relation. An attempted replay consumes the empty database once migrations begin, including when a
later input or runtime check fails; retry with another new database rather than erasing evidence.

Example blind replay:

```bash
export ORIMERA_EVALUATION_OWNER_DATABASE_URL='postgresql://owner:...@host/orimera_eval_001'
export ORIMERA_DATABASE_URL='postgresql://orimera_app:...@host/orimera_eval_001'

uv run orimera-eval replay-bundle \
  --corpus /private/OGC-1 \
  --purpose blind_evaluation \
  --blind-key-file /private/keys/ogc-1-blind.key \
  --actor evaluation-operator-01 \
  --access-audit /private/evaluation/audits/ogc-1-run.jsonl \
  --data-dir /private/evaluation/runtime/ogc-1-run \
  --archive-parent /private/evaluation/archives
```

The blind key is read from a file so it does not appear in shell history or process arguments. The
access audit path must not exist; the command will not append to an earlier proof. The default path
runs the live model-manifest preflight before creating a client. `--offline` is accepted only for an
explicitly synthetic contract test and is refused for a real bundle.

The replay performs two passes over the authorized split. The first runs the actual ingest pipeline.
The second must resolve existing artifacts and make zero additional model calls. The archive retains
the metadata and label files, never source media; access audit; clean-database proof; applied
migrations; stage definitions; attempts; ordered model ids tried; actual provider-reported cost;
reuse events; artifacts; and source coverage. Extra files in the corpus inventory are refused, which
prevents source media from being smuggled into the metadata archive.

The machine record contains a `phase_2_exit_gate` object. It stays blocked for a synthetic bundle, a
development rather than blind split, unsafe runtime role, ingest failure, replay model call, missing
source run, or incomplete metric baseline. Today `metric_baseline_complete` is false because the
new L0-L11 bundle has not yet been connected to every baseline scorer. That is a named remaining
implementation gap, and no successful mechanical replay is reported as the OGC-1 baseline.

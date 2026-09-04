# Evaluation run archives

Status: **IMPLEMENTED; REAL OGC-1 REPLAY REMAINS BLOCKED**.

A report archive is one application write-once directory named by a run UUID. The evaluator creates
the directory exclusively, writes each member once, writes `MANIFEST.json` last, and makes the files
read-only. A second run with the same UUID is refused. The manifest inventories the exact byte count
and SHA-256 of every member and commits the manifest metadata and inventory to one root SHA-256.

This is not WORM storage and is not described as tamper-proof. A host administrator can change an
ordinary filesystem. Verification detects replacement only when the root printed at creation was
retained separately and supplied to the verifier:

```bash
uv run exulanica-eval verify-archive \
  --archive /evaluation/runs/00000000-0000-0000-0000-000000000000 \
  --root-sha256 <root printed when the archive was created>
```

The archive includes:

- the human report and `exulanica.evaluation-run/v1` machine record;
- the exact corpus manifest bytes used by the legacy evaluator;
- the full clean Git commit and tree ids; a dirty checkout is refused;
- the exact model-manifest bytes and SHA-256, every primary and fallback model id, and explicit null
  revisions because the configured serverless provider exposes no model revision;
- the reviewed current stage definitions, versions, parameters, parameter digests, and supplied
  run-time bindings;
- the exact packaged migration filenames and checksums;
- the applied migration rows actually present in the measured database;
- pipeline runs and events joined by the frozen source SHA-256 set; and
- artifacts, actual durations, attempts, retry and reuse counts, model references, and provider- or
  stage-reported costs.

Missing usage remains null. It is never estimated. Host names and error-message text are replaced by
SHA-256 values in the archive; their identity and presence remain comparable without exporting those
private strings. Migration 0019 records the ordered model identifiers tried by new model-backed
terminal events. Historical rows and a model call that fails before returning its attempt metadata
remain null, and the execution summary names those events with
`model_attempt_provenance_complete = false`; it does not reconstruct them from today's manifest.

The existing `run` command can create this archive with `--archive-parent`. That path still reads the
old synthetic `MANIFEST.json` format, so its record explicitly has no split, blind-access receipt, or
gold question fixture and cannot pass Phase 2. It exists to preserve and verify the measurements the
current harness can genuinely make while the real `CORPUS.json` bundle is unavailable.

The Phase 2 exit gate additionally needs a clean-database replay from the real OGC-1 split bundle.
No archive format can substitute for those absent inputs.

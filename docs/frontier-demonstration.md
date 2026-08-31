# Frontier demonstration command

Status: **IMPLEMENTED AND DEVELOPMENT-EXIT-GATED; AUTHORIZED PERSONAL-CORPUS RUN PENDING**.

`orimera-frontier demonstrate` is the Phase 8 source-to-package acceptance path. It starts from
one operator-authorized ordinary photo directory and a versioned manifest, then composes the real
ingest, evidence, Selection, graph, spatial-authority, style-authority, deletion, and World Memory
Package boundaries. It does not contain a second implementation of any of them.

The PostgreSQL acceptance test uses generated development photographs and an in-process counting
vision fake so that it cannot spend money. That test proves the orchestration contract; it is not a
consented personal-corpus result, reconstruction-quality result, or deployment claim. No authorized
personal directory was supplied while this command was built, so the real-data demonstration
remains an external run rather than a result recorded in this repository.

## 1. Invocation and destructive boundary

```text
uv run orimera-frontier demonstrate \
  --manifest /outside-git/frontier-build.json \
  --photo-dir /authorized/photos \
  --data-dir /outside-git/orimera-data \
  --output /outside-git/frontier-run \
  --private-key /secure/location/wmp-ed25519.pem \
  --confirm-source-deletion
```

The command requires `ORIMERA_DATABASE_URL`. It applies pending migrations, provisions the
manifest workspace, and then runs the gate. The signing key must already exist and must be Ed25519;
the command never generates or persists a production secret.

`--confirm-source-deletion` is intentionally required before any work begins. Step 10 writes a
durable capture tombstone for the manifest's `deletion_demo.path`. It does **not** delete or mutate
the original file in `--photo-dir`; the receipt records that distinction. Without the flag, the
command exits nonzero at the named `source_deletion_confirmation_required` terminal gate and does
not create the output directory.

The output path must not exist. This prevents a second run from overwriting signed packages or
mixing receipts from different source sets.

## 2. Build manifest v1

The manifest profile is `orimera-frontier-build/v1`. Its exact top-level fields are:

```json
{
  "profile": "orimera-frontier-build/v1",
  "workspace_id": "00000000-0000-0000-0000-000000000000",
  "actor_id": "00000000-0000-0000-0000-000000000000",
  "world_id": "atlas:default",
  "sources": [
    {"path": "a.jpg", "sha256": "<64 lowercase hex>", "bytes": 1},
    {"path": "nested/b.jpg", "sha256": "<64 lowercase hex>", "bytes": 1}
  ],
  "pipeline": {
    "vision": "unavailable",
    "depth": "unavailable",
    "model_manifest_sha256": "<sha256 of orimera/models/models.manifest.json>"
  },
  "precomputed_artifacts": [],
  "adaptation": {
    "profile_id": "origin-landscape",
    "profile_version": 1,
    "parameters": {"vitality": 1}
  },
  "deletion_demo": {"path": "a.jpg"}
}
```

The two runtime modes are `vision: configured|unavailable` and `depth: moge|unavailable`.
Configured vision performs the live model-catalog preflight and loads the normal role-routed
Nebius client. `moge` loads the reviewed optional depth implementation. A requested implementation
that cannot load is a named configuration stop, not an implicit downgrade. An explicit
`unavailable` mode is the honest capture-only or source-first fallback.

The manifest:

- is strict: unknown or missing keys, duplicate JSON keys, floats at any depth, malformed UUIDs,
  and noncanonical relative paths are refused;
- requires two or more unique source byte digests, because removing one source must leave a real
  fallback region rather than an empty world;
- binds every source's exact byte size and SHA-256 digest;
- requires the source list and precomputed declarations in canonical order;
- refuses symbolic links, unsupported files, missing files, unlisted files, and post-manifest byte
  changes anywhere in the recursive directory; and
- binds the pipeline to the checkout's model-manifest SHA-256.

Precomputed artifact declarations have exact fields `artifact_id`, `kind`, `sha256`, `bytes`,
`producer`, and `use`. In v1, `use` must be `disclose-only`. There is no reviewed importer for
external COLMAP or splat work at this boundary, so the command records these artifacts as
`disclosed-not-consumed` and never pretends their work occurred in the live formation ledger.

## 3. What the command proves

One successful invocation performs these gates in order:

1. ingests every exact manifest source in a watched batch and projects formation from durable
   pipeline events;
2. reconstructs one stored `EvidenceAddress`, verifies its span digest, opens original bytes from
   the content-addressed store, re-hashes them, and lists their real ledger events;
3. reads the semantic graph, compiles an unconstrained capture Selection, builds an EvidencePacket,
   renders the deterministic answer, and runs the answer validator;
4. deterministically composes one stable region per live manifest source and labels it from the
   current `reconstruction_rung_is` assertion, using named source-first rung 4 when none exists;
5. previews and discards one reviewed style proposal, previews two more from one base, applies one,
   verifies stale rejection of the other, and rolls back to the original semantics;
6. creates two structural previews from one protected base and verifies that compare-and-swap
   rejects the stale one;
7. projects and signs an initial World Memory Package containing an explicit operational
   evaluation report;
8. starts a separate verifier process after removing database URL and common PostgreSQL credential
   variables from its environment;
9. repeats ingest, requires zero model calls and zero recomputed capture stages, reuses the exact
   spatial snapshot, and exports the new provenance state; and
10. tombstones one named capture, recomposes the surviving stable regions, exports again, verifies
    it independently, and records a value-redacted semantic package diff.

The repeat package root is expected to differ. A truthful World Memory Package includes the new
`stage_reused` ledger events, repeat evaluation, and package-parent lineage. Suppressing those facts
to force root equality would turn idempotency into missing provenance. Reuse is proved directly by
`model_calls: 0`, an empty `stages_run`, populated `stages_reused`, and the unchanged spatial
snapshot digest.

## 4. Outputs and fallbacks

The output directory contains:

- `package-initial/`, `package-repeat/`, and `package-after-deletion/`;
- canonical `evaluation-initial.json`, `evaluation-repeat.json`, and
  `evaluation-after-deletion.json`; and
- canonical `frontier-receipt.json`.

If a gate fails after output creation, the CLI also attempts to retain
`frontier-terminal.json` with the named gate and failure detail. Partial artifacts remain available
for diagnosis and are never presented as a successful receipt.

The evaluation documents intentionally mark consented-corpus metrics unavailable. This command has
no OGC-1 gold labels or blind split and does not turn an operational demonstration into an accuracy
claim. Receipt fallbacks separately identify unavailable vision, unavailable reconstruction,
source-first rung 4, absent precomputed work, and the deleted-region omission.

Generated test packages, generated photographs, content-addressed blobs, model responses, signing
keys, and real run receipts belong outside Git.

## 5. Executable evidence

- `tests/test_frontier_manifest.py` covers strict schema, exact inventory, hash changes, symbolic
  links, float refusal, duplicate content, and precomputed substitution refusal.
- `tests/test_frontier_demonstration.py` runs the full lifecycle on PostgreSQL: two initial model
  calls, zero repeat calls, evidence opening, supported answer, rung-4 fallback, structural and
  style stale rejection, rollback, three independently verified packages, one durable tombstone,
  surviving source preservation, and a semantic diff that names a removed capture.
- `uv run lint-imports` places `orimera.orchestration` above every reusable boundary, so no product
  package can depend on the acceptance workflow.

The missing final evidence is one user-authorized run with an explicit real photo directory,
credential/hardware choices matching its configured modes, a user-supplied signing key, and outputs
retained outside Git.

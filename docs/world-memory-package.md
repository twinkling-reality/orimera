# World Memory Package v1

Status: **BUILT AND EXIT-GATED**. The implementation profile is `orimera-wmp-1.0`.

The World Memory Package (WMP) is a signed projection of one PostgreSQL snapshot. It is not the
live store, a backup, a consent grant, or an executable world. An exported copy cannot be recalled.
After a deletion, a new export has a new root and the semantic diff is the durable account of what
was removed or recomputed.

## Standards and compatibility boundary

`wmp/profile.json` is the versioned Orimera profile. `ro-crate-metadata.json` uses the RO-Crate 1.2
context by reference, describes `./` as the root Dataset, and declares the Orimera profile on that
root. The same graph contains a Croissant 1.0 and Croissant RAI 1.0 compatibility node with the
package limitations and sensitive-information declaration. WMP does not claim that its component
JSON documents are generic Croissant record sets.

Canonical component files use Orimera's strict no-float JSON subset. That subset has the sorted
keys, UTF-8, and insignificant-whitespace properties needed by RFC 8785, but goes further: an IEEE
754 value is never emitted as a JSON number. Historical database floats are represented as tagged
exact hexadecimal values. Protected topology, placement, appearance, and interaction values remain
their fixed-point integers or reviewed choices.

## Snapshot, publication, and receipt

`project` requires an idle workspace-scoped connection and starts a `REPEATABLE READ` transaction.
The first reads capture the current structure, appearance, and interaction pointers. Every graph,
evidence, artifact, provenance, evaluation, deletion, and policy component is then read from that
same database snapshot. The projector writes a sibling staging directory, scans every JSON payload,
builds and signs the manifest, inserts the append-only `world_package_export` receipt, and renames
the staging directory into place before commit. A failed transaction removes the newly published
directory.

The receipt records the protected current-version IDs, profile version, Merkle root, manifest
digest, optional parent root, Ed25519 public-key fingerprint, actor, export policy, and database
time. None of those audit rows feed the package root, so exporting unchanged state with the same
lineage produces the same root. The receipt is the forty-eighth workspace-keyed FORCE RLS table and
rejects update and delete.

No signing key is generated implicitly. `project` requires an explicit Ed25519 private-key path.
`keygen-test` is named and reported as ephemeral test material; tests generate keys only in their
temporary directories or memory. No production key or trust decision is committed here.

## Inventory and privacy boundary

The package contains canonical JSON for:

- semantic graph, evidence descriptors, and digest-only authorized fetch references;
- reconstruction descriptors and honest unavailable, purged, repair, or resolver-required state;
- current topology, layout, placement, neighborhood, appearance, and interaction state;
- reviewed appearance and interaction registry references required to interpret current values;
- pipeline/model attempt provenance without hosts, error messages, or payload bytes;
- explicitly supplied evaluation reports, or `unavailable` with its reason;
- deletion tombstones without the private reason or requesting actor; and
- export/consent boundary and generated-content declarations.

The default scanner rejects raw media, credentials, biometric templates, embeddings, private
conversation fields, model caches/internals, training intermediates, executable UI assets, shaders,
and remote executable bindings. Media references contain a digest, size, type, RFC 6920 `ni` URI,
and the explicit statement that an authorized content-addressed resolver is required. An `ni` URI
is not presented as a public download URL.

## Integrity format

`wmp/manifest.json` lists every payload path, byte length, and SHA-256 digest in sorted path order.
Leaves bind a domain separator, the UTF-8 path, and the file digest. Internal nodes bind a separate
domain separator and the two child hashes; an odd final child is duplicated. `wmp/signature.json`
contains the Ed25519 public key and a signature over the canonical profile version, manifest digest,
and Merkle root. The manifest and signature do not include themselves in the Merkle inventory.

The offline verifier rejects non-canonical JSON, symbolic links, inventory additions/removals,
digest or length changes, root changes, signature changes, unsupported profiles, and prohibited
content. Integrity does not establish export authorization; `policy/export.json` and the CLI say so
explicitly.

## Commands

```text
orimera-wmp project --workspace UUID --actor UUID --private-key KEY --output DIRECTORY
orimera-wmp verify DIRECTORY
orimera-wmp inspect DIRECTORY
orimera-wmp diff BEFORE_DIRECTORY AFTER_DIRECTORY
orimera-wmp import-check DIRECTORY [receiver capability declarations]
```

`verify`, `inspect`, `diff`, and `import-check` do not open PostgreSQL. Diff output reports semantic
JSON pointers and before/after value hashes, not the values themselves. `import-check` never mutates
a live world; absent receiver capability declarations produce `indeterminate`, not a fabricated
compatibility pass. Import remains a later explicit transaction and is not implemented as a side
effect of inspection.

## Exit evidence

The phase-specific tests cover a clean subprocess with database URLs removed, one-byte payload and
manifest mutation, every prohibited class, symlink and unexpected-file rejection, concurrent
mutation after the repeatable-read snapshot begins, immutable audit receipts, deterministic
unchanged re-export, and deletion followed by a new root and semantic removed-state diff. The full
backend PostgreSQL suite, Ruff, migration count, and import boundaries are run before the phase
commit; those command results, not this status sentence alone, are the exit gate.

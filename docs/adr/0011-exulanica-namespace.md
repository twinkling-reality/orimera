# ADR-0011: Exulanica becomes the canonical technical namespace before release

- Status: **ACCEPTED 2026-09-04.** Mode A, a pre-release clean cutover.
- Date: 2026-09-04
- Deciders: Exulanica build, from the evidence recorded below rather than from an assumption
  that production state exists or that it does not.
- Supersedes: the roadmap instruction to keep the internal `orimera` namespace during active
  backend work. That was a temporary compatibility hold, not a permanent protocol freeze.
- Related: [world-memory-package.md](../world-memory-package.md);
  [deployment.md](../deployment.md);
  [frontier-roadmap.md](../frontier-roadmap.md).

## Context

The public product name is already Exulanica. Atlas remains the name of the navigable
application. The Python package, npm scope, CLI, environment variables, database settings,
headers, permalinks, media types, and World Memory Package profile still said Orimera. An
earlier hold treated those strings as frozen so that a mid-reconstruction rename would not
invalidate signed artifacts. That hold is a compatibility decision. It is not evidence that
any Orimera identifier has escaped into non-disposable state.

This record asks whether any such obligation exists, then chooses a migration mode.

## Evidence searched

The question is not "could a stranger have cloned the public repository." The question is
whether this project has created an externally observable or non-disposable Orimera
compatibility obligation. Each row was checked on 2026-09-04.

| Candidate obligation | What was searched | Finding |
| --- | --- | --- |
| Externally distributed or retained signed WMP packages | Repository tree, gitignored `.orimera/`, `signature.json` / `ro-crate-metadata.json` outside the source profile fixture | The only WMP profile on disk is the in-repo source fixture `orimera-wmp-1.0.json`. No signed package directory was found. Frontier demonstration still records that the missing evidence is a user-authorized run with a user-supplied signing key. |
| Real user or production database rows | Local PostgreSQL catalog; product claims in README and product specification | Local databases are `orimera_spine_test`, `orimera_claim_test`, `orimera_plan_test`, and `orimera_verify_test`. All are scratch databases whose names contain `test`. README: no personal photograph library has been ingested; nothing is deployed. |
| Deployed object-storage keys | Compose and API default to a local content-addressed directory; `.orimera/local/blobs` exists | Local developer blobs only. Gitignored. No object-store bucket, no published prefix, no hosted resolver. |
| Issued `orimera://` permalinks | Tests and synthetic fixtures emit the scheme; no archive of issued citations | No retained answer archive or exported citation set exists in this checkout. Permalinks in tests are disposable. |
| Published packages or third-party clients | PyPI `orimera` and `exulanica`; npm `@orimera/app`; GitHub Releases, tags, and packages | HTTP 404 on PyPI and npm. No git tags. No GitHub Releases. No GitHub Packages. Workspace packages are private. |
| Active deployments, secrets, headers, or environment integrations | README project status; compose file; GitHub Actions | "Assembled for development, but not deployed." CI creates a throwaway `*_test` database per run. Compose is a local development file, not a hosted environment. |
| Artifacts that must remain independently verifiable | WMP tests sign ephemeral keys in temporary directories; no committed private key; no committed signed crate | The verifier and projector exist. No externally retained signed root was found. |
| Public source repository | `gh api repos/twinkling-reality/orimera` | Visibility is public. Created 2026-08-27. Zero forks, zero stars. Source history remains a historical fact. Public source is not a released package, a production database, or an issued permalink. |

What this search cannot prove: an unknown third party could have cloned the public source and
produced a signed package or a local database. No such artifact is known to this project, no
release invited that use, and no support obligation was published. That residual risk is
recorded here and accepted.

## Decision

**Mode A: pre-release clean cutover.** Exulanica is the canonical technical namespace for
every new write and for every disposable fixture. The pre-release Orimera WMP profile is
withdrawn before release. WMP remains version 1 under the corrected Exulanica profile.
Disposable development fixtures, local test databases, unsigned packages, and generated
examples are invalidated and regenerated.

Atlas stays Atlas.

Applied SQL migrations 0001 through 0027 are not rewritten. They are checksummed historical
files. A new forward migration replaces the live GUC and the WMP receipt check. Local
databases that already applied 0001 through 0027 are disposable and are recreated or
migrated forward. Their Orimera-named contents are not production state.

Local `.orimera/` developer data is not deleted by this migration. New defaults write
`.exulanica/`. A developer who wants the old local store copies or moves it. The runtime
does not keep a permanent Orimera path alias.

## Classification

Every occurrence of an Orimera identifier falls into exactly one class.

1. **Public branding.** Product name, page titles, landing copy, publisher-facing docs.
   Writer: Exulanica. Reader: Exulanica. No alias.
2. **Rename-safe internal implementation.** Python package, npm scope, CLI entry points,
   compose project name, container user, FastAPI title, test hostnames, bakeoff console
   prefixes, CSS class names that are not persisted. Writer: Exulanica. Reader: Exulanica.
   No alias.
3. **Persisted identity.** PostgreSQL role names, bootstrap database name, session GUC,
   local data-directory default, browser storage keys. Writer: Exulanica. Reader: Exulanica
   after cutover. Local leftovers are disposable or manually moved. Applied migrations keep
   their historical text.
4. **Wire or protocol contract.** HTTP evidence headers, point-map media type, environment
   variable names, OpenAPI title. Writer: Exulanica. Reader: Exulanica. No dual emit.
5. **Signed or digest-bearing input.** WMP profile version, profile URL, JSON-LD namespace,
   Merkle domain-separation prefixes, canonical-JSON profile name, signature payload
   profile, typed JSON values, package URNs, evidence permalink scheme. Writer: Exulanica
   v1. Reader: Exulanica v1. The former pre-release Orimera profile is withdrawn.
6. **Historical compatibility fixture.** Applied SQL 0001 through 0027, git history, and
   this ADR's evidence table. These remain byte-for-byte as written. They are not live
   writers.

## Namespace and version matrix

| Old identifier | New identifier | Reader | Writer | Migration | Rollback | Legacy removal |
| --- | --- | --- | --- | --- | --- | --- |
| Python `orimera` | `exulanica` | new only | new only | `git mv` plus import rewrite | revert the commit | immediate; no shim |
| `@orimera/*` | `@exulanica/*` | new only | new only | package.json and imports | revert the commit | immediate; no shim |
| `orimera-*` CLI | `exulanica-*` | new only | new only | `[project.scripts]` | revert the commit | immediate; no alias |
| `ORIMERA_*` | `EXULANICA_*` | new only | new only | env helper reads the new name | revert the commit | immediate; no fallback |
| `orimera_app` / `_ro` / `_purge` | `exulanica_app` / `_ro` / `_purge` | new only | new only | provisioner defaults; compose URLs | recreate local roles | immediate on disposable DBs |
| Postgres DB/user `orimera` | `exulanica` | new only | new only | compose defaults; CI `exulanica_spine_test` | recreate local DB | immediate on disposable DBs |
| GUC `orimera.workspace_id` | `exulanica.workspace_id` | new function after 0028 | new only | migration 0028 replaces `current_workspace()` | restore previous function via a later migration | 0001 text stays historical |
| `.orimera/` | `.exulanica/` | new default | new default | change defaults; do not delete old tree | point `EXULANICA_DATA_DIR` at the old tree | no automatic delete |
| `orimera.atlas.*` storage keys | `exulanica.atlas.*` | new only | new only | new keys; leftover browser keys are disposable | revert the commit | immediate |
| `X-Orimera-*` | `X-Exulanica-*` | new only | new only | emit and read the new family | revert the commit | immediate |
| `application/vnd.orimera.point-map` | `application/vnd.exulanica.point-map` | new only | new only | constant and tests | revert the commit | immediate |
| `orimera://` | `exulanica://` | new only | new only | `URI_SCHEME` and parser | revert the commit | immediate |
| `orimera-wmp-1.0` and `orimera-wmp-*` prefixes | `exulanica-wmp-1.0` and `exulanica-wmp-*` prefixes | new only | new only | new profile file; 0028 receipt check; regenerate fixtures | revert the commit and 0028 | withdrawn before release |
| `orimera:IEEE754Binary64` and kin | `exulanica:IEEE754Binary64` and kin | new only | new only | package encoder | revert the commit | withdrawn before release |
| GitHub `twinkling-reality/orimera` | `twinkling-reality/exulanica` | new URL after rename | n/a | `gh repo rename` last | GitHub redirect | after code and docs are green |
| Atlas | Atlas | unchanged | unchanged | none | none | never renamed |

## Consequences

- New packages, headers, permalinks, and WMP roots say Exulanica.
- A verifier from this tree will not accept a package that still declares `orimera-wmp-1.0`.
  That is intended. No such package was released.
- A local database that already applied 0001 through 0027 keeps those checksums. It becomes
  current only by applying 0028, or by being dropped and recreated. Both are acceptable for
  disposable development databases.
- Git history and applied migration files continue to mention Orimera. Those mentions are
  historical facts.
- The repository rename happens after the code and documentation pass, so in-tree URLs and
  the live GitHub name agree.

## Rejection of Mode B

Mode B would introduce `exulanica-wmp-2.0`, dual Merkle prefixes, dual permalink schemes,
dual headers, and dated alias-removal criteria. That machinery is the right answer when a
signed root, a production row, or a third-party client exists. The evidence table does not
show that obligation. Keeping Orimera as a live writer "because an earlier note called it
frozen" would preserve a pre-release name as if it had been released.

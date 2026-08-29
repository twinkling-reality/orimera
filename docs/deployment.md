# Deployment

- Status: mixed, labelled per claim. See [README.md](README.md) for the status convention.
- Date: 2026-08-28.
- Relationship to other documents: this expands
  [architecture-overview.md](architecture-overview.md) sections 2, 2.1, 4 and 7 into an operational
  plan. Where a platform fact appears in both, the architecture overview is the source and this
  document does not restate the verification.
  [runtime-verification.md](runtime-verification.md) overrides both on any conflict.

The demonstration has to run without an operator for roughly **46 days** after a release is cut.
This is a single operator project, and that is the longest gap between hands-on attention the
schedule realistically produces. Nobody looks at the application during that window. Every choice in
this document is shaped by that gap rather than by steady-state operations.

---

## 1. What is decided, and what is not

The shape of the deployment is decided. The concrete target is not.

| Question | Status |
| --- | --- |
| Which components exist and what each one does | **DECIDED**, section 2 |
| That the browser client is a static build with no server of its own | **DECIDED**, section 2 |
| That large assets are served from object storage and never from the client bundle | **DECIDED**, section 4 |
| That the database sits in one consistency domain with the API, not in a managed service and not behind a network hop | **DECIDED**, section 3 |
| That the model catalog preflight fails the build on a withdrawn identifier | **DECIDED and implemented**, section 7 |
| That reconstruction never runs in the live request path | **DECIDED**, section 8 |
| Whether the API and database host is a Compute virtual machine or a Serverless endpoint | **Recommendation on record, not locked.** Section 3 and section 10 |
| Which cloud account, project and region placement | **OPEN**, section 10 |
| The domain name | **OPEN**, section 10 |
| Whether the static client host stays on the default choice | **OPEN**, section 10 |
| Who performs the weekly check through the unattended window | **OPEN**, section 9 |
| Whether the health endpoint exists | **DECIDED and implemented.** `/healthz` and `/readyz`, section 6 |
| Whether the redeploy command exists | **OPEN.** Specified in section 9 and not implemented |

**The artefacts exist. Nothing has been provisioned.** The distinction is the whole of this
section and it is worth stating precisely, because "there is a Dockerfile" and "there is a
deployment" are different facts and only the first one is true.

What exists in the repository, and is checked by `tests/test_deployment.py`:

*   `Dockerfile`, one image for all three commands: uvicorn serves the API, `orimera-db` migrates
    and provisions the two roles, `orimera-ingest` ingests a directory. Non-root, no apt packages,
    liveness on `/healthz` and never on `/readyz`.
*   `.dockerignore`, an allowlist rather than a denylist, because `credentials.py` walks up from
    the working directory looking for a `.env` and a denylist is one forgotten line away from an
    image that carries a credential.
*   `compose.yaml`, a local composition against `pgvector/pgvector:0.8.6-pg18`, which is the
    documented target matched exactly.
*   `.github/workflows/check.yml`, running ruff, the import contracts, pytest with
    `ORIMERA_REQUIRE_POSTGRES=1`, the web workspace's `pnpm check`, and an image build.

**What is still open, and it is the part that needs a person.** No cloud account, no project, no
region, no domain, no registry and no host. Every one of those is a decision rather than a task,
and nothing in this repository names one: `tests/test_deployment.py` asserts that no artefact
carries a hostname or an account identifier, so a value typed in by accident fails the build.

**The image is built and was run. 2026-08-29, 222 MB.** `docker build .` completes, and the built
image was exercised rather than only weighed:

*   `uvicorn` serves. The container's own `HEALTHCHECK` reaches `/healthz` and gets 200.
*   `orimera-ingest --help` and `orimera-db --help` both run, which is the claim at the top of the
    Dockerfile that one image carries three commands.
*   `POST /intake` accepted a photograph through the container and returned 202, and the
    derivative worker inside it drained the queue: intake and rendition ran, and vision did not,
    because no model credential was passed. That is the correct behaviour and the honest half of
    the test, since a stage reported as done that never ran is the failure this project is
    written against.
*   With a connection string naming a role that does not exist, the container **refuses to start**
    and says which role, rather than starting and failing on the first request. That is section
    5.3's "fail closed at startup", observed rather than asserted.

The reconstruction extra is still absent from the image, exactly as the Dockerfile's header says.

---

## 2. Topology

Five places where code or data lives, and one boundary that matters more than the rest.

```
  Browser (user)
        |
        |  static HTML, JS, CSS                     large derived assets
        |  over HTTPS                               over HTTPS, cacheable
        v                                                    |
  Static host  ------------------------------------>  Edge cache (optional)
        |                                                    |
        |  JSON API calls                                    v
        |                                          Nebius Object Storage
        v                                          (eu-north1, versioned,
  API process ----------------+                     anonymous read on a
  (single host)               |                     narrow prefix)
        |                     |
        |  local socket       |  HTTPS
        v                     v
  PostgreSQL 18          Nebius Token Factory
  + pgvector             (reasoning, vision, embeddings)
  (same host)                 |
                              +--> Tavily (opt-in public entity lookup)

  Out of band, never in a request:
  Nebius Serverless Jobs  -->  ingest, perception, reconstruction
                               write to Object Storage and PostgreSQL, then terminate
```

| Concern | Runs on | Why there |
| --- | --- | --- |
| Browser client | Static host (Vercel Hobby by default), no server side rendering, no serverless functions | The client is a build artifact. Giving it a runtime would add a component that can die during the unattended window in exchange for nothing |
| Derived assets: point maps, splat scenes, image derivatives | Nebius Object Storage, eu-north1, Intelligent class | Section 4 |
| API and PostgreSQL 18 with pgvector | One host, database as a local process, restart policy, nightly dump to Object Storage | Section 3 |
| Asynchronous ingest and perception | Nebius Serverless Jobs, self terminating, per second billing | Failure is retryable and idempotent, which is what makes a self terminating job the right shape |
| Reconstruction (structure from motion plus splat or point map training) | Nebius Serverless Job on a GPU flavour, preemptible, checkpointed | Minutes to hours. **Never in the live path.** Scenes are reconstructed once, ahead of deployment, and the results are static assets |
| Reasoning, vision and embedding models | Nebius Token Factory, global base URL only | The identifiers and their fallbacks are in `orimera/models/models.manifest.json` |
| Public entity lookup | Tavily, opt in, server constructed query only | Queries are built on the server and never carry corpus content |

**The boundary that matters** is between work that must answer inside a request and work that must
not. Reconstruction, perception and batch ingest take minutes to hours. They run as jobs that
terminate. A job failure is retryable, a database failure is not, and that asymmetry is the only
reason a boundary is drawn at all. Everything in the request path is one process talking to a local
database.

**Region pinning.** All GPU work goes to eu-north1, because that is where the GPU quota is non zero.
Token Factory reports its public endpoints as global and warns that the processing location can
change without notice, so only the global base URL is ever used and nothing in the codebase branches
on a region string.

---

## 3. Where the database runs, and why

### 3.1 The decision

**The database runs as a process on the same host as the API, on a small general purpose virtual
machine with a network attached SSD volume and a restart policy, with a nightly dump to object
storage.** It is not a managed service and it is not behind a network hop.

Three separate arguments arrive at the same place, and any one of them would be sufficient.

**Argument one: deletion needs one consistency domain.** This is the reason that is about
correctness rather than money. An embedding derived from a photograph is not a pointer to that
photograph, it is a lossy copy of its contents. When a subject withdraws consent, the embedding has
to be purged in the same transaction as the interval it was derived from. Two storage systems means
a two phase delete, and a two phase delete can be left half done: the source is gone, the derived
vector is not, and the system is now holding biometric data whose provenance record no longer
exists. One PostgreSQL, with embeddings in a table partitioned by workspace, makes that failure mode
unrepresentable rather than merely tested for. This argument also rules out a separate vector
database and a separate graph database, and it is worked through in
[architecture-overview.md](architecture-overview.md) section 3.1.

**Argument two: recovery behaviour across 46 unattended days.** The alternative placement, a
container co-located with the API on a Serverless endpoint, scores marginally better on platform
alignment. It also puts the database on the least reliable component in the stack. The platform
terms for Serverless AI state that there is no service level provided and that it "does not provide
automatic retry, recovery, or redundancy mechanisms", and that "infrastructure failures may result
in workload failure with no automatic recovery". Typical endpoint lifetime is documented as hours to
days. Against a 46 day unattended window that is the wrong component to hold the only copy of the
data. Volume mounting is documented for Serverless **jobs** and is undocumented for endpoints, so the
endpoint variant additionally rests on an undocumented assumption about where the data would even
live.

**Argument three: cost, which turns out not to be a tradeoff at all.** Serverless AI has no pricing
of its own and applies Compute pricing, so a `2vcpu-8gb` shape costs the same either way, about
$35.71 per month. The managed database option is the expensive one: a documented `4vcpu-16gb`
example at $0.28 per hour is roughly $204 per month, about **+$755 across the project period, for a
database that holds under a gigabyte**. That is more than the entire expected AI inference spend, for
a sub-gigabyte database on a single tenant demonstration. Section 8 records it as a named trap for
exactly that reason.

The platform constraint is satisfied identically under both placements, because a Compute virtual
machine is still Nebius AI Cloud. Serverless **Jobs** are retained for reconstruction, perception and
batch ingest, which is where a self terminating per second billing model is a genuine fit and where
failure is retryable, and that use also captures the platform alignment benefit in the one place
where it costs nothing.

### 3.2 The disagreement, preserved

The research streams disagreed about this and the disagreement is real. One stream recommended the
Serverless endpoint placement on platform alignment grounds. That recommendation is not
unreasonable, it is optimising a different variable: alignment with a stated platform preference at
deployment time, rather than survival across an unattended window. This document optimises for
survival. The reasoning is recorded rather than the conclusion alone, so that a reader who weighs
those variables differently can see exactly where they would diverge.

**ASSUMPTION.** That a preview grade service can be relied on for the unattended window at all. This is
being settled by running a canary endpoint continuously and logging every restart, failure and
unexplained outage. That experiment quantifies how right the co-located placement is; it does not
decide it, because arguments one and three stand regardless of the answer.

### 3.3 Rejected alternatives outside Nebius

| Alternative | Why rejected |
| --- | --- |
| Render free tier, whose web services spin down after 15 minutes idle and whose free PostgreSQL expires 30 days after creation | **VERIFIED** and fatal against a 46 day unattended window. The database would expire 30 days in, with nobody present to notice, and the application would be dead before a user ever loaded the page |
| Fly.io, technically fine and cheap | Not Nebius. The project constraint is that the system runs on Nebius Token Factory or Nebius AI Cloud, and that constraint is not negotiable. Kept as an unused break-glass configuration only |
| Cloudflare R2 as the asset origin | Free egress would save roughly $2 to $10 across the project. Rejected because keeping the origin on Nebius keeps the platform constraint literally true. An edge cache in front of the Nebius origin is compatible with this and is recommended |

---

## 4. Static assets and large derived files

### 4.1 What is actually being served

The heavy assets are reconstructed scene data. The delivery format is **streamed SOG**, which is a
`meta.json` manifest plus lossless WebP images, **VERIFIED** as typically 15 to 20 times smaller
than an equivalent PLY and decoded by the browser's native WebP decoder rather than by a per element
JavaScript parse. PLY is a build time archive and is never shipped to a browser. `.spz` is the
interchange format.

Scale, from the renderer measurements in
[adr/0003-renderer-selection.md](adr/0003-renderer-selection.md), taken on the machine that will run
the demonstration:

| Scene load | Peak browser heap | Note |
| --- | --- | --- |
| 3 islands at 1M points | 39 to 75 MB depending on binding | Comfortable |
| 3 islands at 4M points | 137 MB on the three.js binding | The selected renderer uses roughly 1.9x the heap of the measured alternative, so island residency matters more, not less |

The consequence for delivery is that **not every island can be resident at once**, so assets are
requested per island as the camera approaches, and distant islands are served at a lower detail rung.
That is a streaming problem, and streaming is what the rest of this section is about.

### 4.2 Why assets never go in the client bundle

**VERIFIED:** the current default static host, Vercel Hobby, caps a static upload at 100 MB and a
build at 45 minutes. A single scene at full density exceeds the first cap on its own, and putting scene data
through a build step would put it against the second.

More fundamentally, scene assets have a different lifecycle from the client code. Code changes when
the application changes. A reconstructed scene changes when it is re-reconstructed, which during the
unattended window is never. Coupling them means every asset change forces a client redeploy and every
client redeploy re-uploads hundreds of megabytes. They are separated because they change at
different rates.

### 4.3 The origin

Nebius Object Storage, eu-north1, Intelligent storage class, with anonymous read granted on a narrow
prefix.

Four platform facts constrain the design, all **VERIFIED** against the object storage compatibility
documentation and quoted in [architecture-overview.md](architecture-overview.md) section 4:

1. **Anonymous public read exists, but not through S3 `Principal` syntax.** It is granted by a bucket
   policy rule using `"anonymous": {}` with a role limited to `storage.viewer`,
   `storage.object-viewer` or `storage.object-lister`, at most 10 rules per bucket and 10 paths per
   rule. Every S3 tutorial for this step is wrong, and the 10 path limit is a real design constraint:
   the public prefix has to be planned, not accumulated.
2. **`GetObject` and therefore HTTP `Range` are supported.** So are `PutBucketCORS`, versioning,
   lifecycle rules and full multipart upload.
3. **Static website hosting is not supported.** Neither are object ACLs, S3 Select, replication,
   event notifications, bucket inventory, Object Ownership, or write once read many retention. The
   bucket is an origin, not a site, and nothing may be designed around an event notification firing.
4. **ETag is not always an MD5 digest.** Integrity checks use the `X-Amz-Checksum-*` headers. An
   upload verification that compares ETags will produce false failures.

**Bucket setup, in order, and the order matters.** Enable versioning **at bucket creation time**.
Enabling it on an existing bucket takes up to 15 minutes to propagate, and during that window a
bucket that appears versioned is not yet protected. Once enabled, versioning can only be suspended
and never disabled, so this is a one way door taken deliberately.

**Write path.** Originals are written under content addressed keys, the SHA-256 of the original
bytes. The runtime service account is granted write and read and is **denied** `DeleteObject` and
`DeleteObjectVersion` by bucket policy. Deletion, when a person requests it, runs through a separate
privileged path that the request path cannot reach. This is deliberately asymmetric: accidental or
injected deletion is impossible from the request path, while intentional deletion remains real.

**The tension, stated rather than hidden.** Versioning plus delete denial makes genuine deletion
harder, not easier. The deletion design carries that weight, and the required wording carries it
too: this arrangement is **append-only by policy**, which is exactly as strong as the bucket policy.
It is not immutable, not write once read many, and not tamper proof. The platform provides no
guarantee that a sufficiently privileged actor cannot delete a version, and an overclaim here would
discount every other claim this project makes.

### 4.4 Caching, and what makes a CDN safe here

Content addressing is what turns caching from a risk into a free win. A key whose name is the hash
of its contents can never have different contents, so it can be cached forever by anything.

| Object class | Key shape | `Cache-Control` | Reasoning |
| --- | --- | --- | --- |
| Scene payloads: WebP planes, `.spz`, image derivatives | Content addressed, SHA-256 of the bytes | `public, max-age=31536000, immutable` | The key changes when the content changes. There is no such thing as a stale hit |
| Scene manifest (`meta.json`) | Stable path per scene | Short max age, revalidated | This is the mutable pointer that names the immutable payloads. It is the only object whose freshness matters |
| Client bundle | Handled by the static host's own fingerprinting | Host default | Not served from object storage |

**Cross origin configuration.** The client is served from one origin and the assets from another, so
the bucket needs a CORS configuration allowing `GET` and `HEAD` from the client origin, and it must
expose the headers the loader reads, including `Content-Range` and the checksum headers if integrity
is verified client side. `PutBucketCORS` is supported. This is a common first deployment failure:
everything works locally, then every asset request fails in the browser with an opaque CORS error.

**Edge cache.** An optional Cloudflare cache in front of the Nebius origin is recommended, specifically
because users may be a long way from eu-north1 and the first impression of the application is how
fast the first island appears. The origin stays on Nebius. The cache is a proxy, not a second source
of truth, and the application must work correctly with the cache absent.

### 4.5 Range requests, described accurately

`GetObject` support means HTTP `Range` works against the origin, and the design keeps that available
deliberately. What it is worth is narrower than it sounds, and it is worth saying so rather than
listing "range requests" as a feature.

- **Where range genuinely helps:** resumable transfer of the large archival objects (`.spz` and PLY)
  during operational work, and any partial read of a large single file container.
- **Where it does not:** the primary browser path. Streamed SOG is a manifest plus a set of WebP
  images, and the loader fetches each image as a whole object. The size win comes from the format
  being 15 to 20 times smaller than PLY and decoding natively, not from byte ranges. Many small
  cacheable objects and byte ranges into one large object are two different solutions to the same
  problem, and this design took the first.
- **What the edge cache does to it:** a cache in front of the origin must be configured to handle
  range requests correctly or to pass them through. A cache that silently collapses a range request
  into a full object fetch turns a resumable download into a repeated one.

**OPEN.** Whether the renderer's SOG loader issues range requests at all has not been observed. It
is answered by loading a scene with the network panel open and reading the request list. Until that
is done, no claim is made here about range requests being on the browser path.

---

## 5. Environment configuration

### 5.1 What exists today

`.env.example` is committed, `.env` is ignored, and the current variables are:

| Variable | Purpose | Consumed by |
| --- | --- | --- |
| `NEBIUS_API_KEY` | Bearer credential for Token Factory | The model client. Named in `models.manifest.json` as `api_key_env`, so even the environment variable name is manifest data rather than a literal in code |
| `TAVILY_API_KEY` | Credential for the public entity lookup | The lookup path only. The feature is opt in and is on the cut list if its egress gate does not hold |
| `ORIMERA_TEST_DATABASE_URL` | Points the database backed tests at a live PostgreSQL 18 server | Tests only. Unset means those tests skip, which is why the suite runs without a database |
| `ORIMERA_DATA_DIR` | Where the content addressed store lives | The API and the ingest command must agree on it, or a citation resolves against a store the bytes are not in |
| `ORIMERA_API_TOKENS` | Bearer token to workspace grant | No default, because a default would be a credential in a repository |
| `ORIMERA_READONLY_DATABASE_URL` | The Selection executor's role | Optional, and `/readyz` says so when it is absent |
| `ORIMERA_DERIVATIVE_WORKER` | Whether this process drains what `POST /intake` queues | Defaults to **on**. Off is for an instance that leaves the queue to somebody else, and `/readyz` reports which it is: a queue nobody drains and a queue drained elsewhere look identical from outside |

### 5.1.1 The request body bound belongs partly to the proxy

`POST /intake` is multipart, and a route runs **after** the body has been received and parsed. So
the checks inside the route bound what reaches the object store and the database, which is what
they exist for, and they cannot bound the temporary file the parser has already written.

`orimera/api/body_limit.py` is pure ASGI middleware and runs ahead of routing. It refuses a request
whose `Content-Length` exceeds 512 MiB before any of the body is read. **It does not cover a request
sent with `Transfer-Encoding: chunked`**, which declares no length; bounding that means counting
bytes already accepted, which is the work the refusal exists to avoid.

A deployment therefore sets a body size limit on whatever terminates TLS in front of the
application: `client_max_body_size` on nginx, `proxy-body-size` on an ingress. Stated here rather
than left to be discovered, because the symptom of its absence is a full disk rather than an error.

### 5.2 What a deployment additionally needs

**PROPOSED.** None of these is read by code in this repository yet, because the service that would
read them does not exist. They are listed so that the shape is settled before the code is written.

| Variable | Purpose | Notes |
| --- | --- | --- |
| `DATABASE_URL` | The application's PostgreSQL connection | Local socket or loopback, since the database is on the same host |
| `ORIMERA_OBJECT_STORE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY` | Object storage write path | The runtime credential is the delete denied service account, never an administrative one |
| `ORIMERA_PUBLIC_ASSET_BASE_URL` | The base the client is told to fetch assets from | Points at the edge cache when one exists and at the origin otherwise. Changing it must not require a rebuild of anything but the client |
| `ORIMERA_ALLOWED_ORIGINS` | Cross origin allowlist for the API | Explicit list, never a wildcard |
| `ORIMERA_ENV` | `development`, `staging` or `production` | Selects log verbosity and whether developer surfaces are reachable |

### 5.3 Rules

- **No secret ever reaches the browser.** The Token Factory key and the Tavily key are server side
  only. The client is given public URLs and nothing else. Any design where the browser calls Token
  Factory directly is rejected outright, because a credential in a static bundle is a published
  credential.
- **Fail closed at startup.** A missing required variable makes the process refuse to start, with the
  variable named in the error. A service that starts and then fails on the first request during
  the unattended window is strictly worse than one that never came up, because the monitoring in
  section 9 would have caught the second.
- **Model identifiers are not configuration.** They live in `models.manifest.json` and are not
  overridable by environment variable. Changing an identifier is required to bump `pipeline_version`,
  which is an input to the response cache key, and an environment override would let an identifier
  change without that bump. A cached answer that outlived the model that produced it is a correctness
  bug wearing a cost saving's coat.
- **Secrets are not committed and are not baked into images.** They are injected at run time.

---

## 6. Health check

**OPEN, and stated before the design: there is no HTTP service in this repository.** The runtime
dependencies are an HTTP client, a JSON schema validator, an imaging library and a data validation
library. There is no web framework. Everything in this section is a specification for a service that
has not been written, and it should be read as a requirement rather than as documentation of
behaviour.

### 6.1 Three signals, not one

Conflating them is the common mistake, and here it would be an expensive one.

| Signal | Path | Cost | Checks |
| --- | --- | --- | --- |
| **Liveness** | `GET /healthz` | Nothing beyond the process itself | The process is running and can serve a request. No dependency is touched |
| **Readiness** | `GET /readyz` | One cheap query and one cheap object storage call | The dependencies a request actually needs are reachable |
| **Catalog integrity** | Not an endpoint. A scheduled run of the preflight command | One public HTTP fetch, no credential, no model call | Every model identifier the application can reach still exists and still declares the capability its role needs |

### 6.2 What readiness actually verifies

| Check | What it proves | What it cannot prove |
| --- | --- | --- |
| `SELECT 1` on the application connection | The database process is up and the connection pool is not exhausted | Nothing about schema correctness |
| Applied migration version equals the version the code expects | The running code and the running schema agree | Nothing about data integrity |
| A `HEAD` on one known asset key | Object storage is reachable, credentials are valid, and the bucket is where configuration says it is | Nothing about whether any particular scene's assets are complete |
| The model manifest parses and every role resolves to an identifier | The application can name a model | **Nothing about whether that model still exists.** That is section 6.1's third signal |

### 6.3 What the health check must not do

- **It must not call a model.** An external check every 5 minutes for 46 days is about 13,200 checks.
  Every reasoning call on this platform spends roughly 200 reasoning tokens before producing any
  output, and that cannot be disabled, so a model call per health check is pure waste. Worse, it
  makes the health signal depend on the prepaid balance: the day the balance runs out, health goes
  red for a reason that has nothing to do with the service being up.
- **It must not claim more than it checks.** A `200` from `/healthz` says the process is alive. It
  does not say the reasoning model still exists in the catalog. That precise gap, a green health
  check sitting in front of a withdrawn model, is the failure the catalog preflight exists for, and
  it is why the weekly check through the unattended window includes a catalog diff and not only a
  ping.
- **It must not be expensive enough to matter.** Readiness runs on every external probe. If it is not
  cheap it will either be turned off or become the thing that falls over.

---

## 7. Model catalog preflight

**This one is implemented.** `orimera/models/preflight.py`, exposed as the console script
`orimera-preflight` and runnable as `python -m orimera.models.preflight`. Exit status 0 when clean
and 1 on any failure, so a build step and a scheduled check can both call it without parsing output.

### 7.1 The risk it addresses

**VERIFIED:** Nebius removed 11 models from Token Factory Serverless on 2026-06-22 and 10 more on
2026-08-31. That is two rounds in roughly ten weeks, against an unattended window of 46 days.

**ASSUMPTION:** that another round lands between feature freeze and the end of the unattended window.
Two rounds in ten weeks is the observed cadence. This cannot be validated in advance, which is
exactly why it is mitigated structurally rather than watched for.

Without the preflight, the failure looks like this: a user opens the demonstration five weeks into
the window, the application calls a model identifier that was withdrawn three weeks earlier, and the
request returns a 404 class error with nobody present to notice. The demonstration is dead and the
first person to find out is a user.

### 7.2 The three checks

| Check | What it catches | Severity |
| --- | --- | --- |
| **Presence** | Every identifier a role can reach, **primary and fallback alike**, appears in the catalog's `flavors[].model_id`. A fallback that has itself been withdrawn is a failover that fails, which is worse than no failover because it is discovered only under load | Fatal |
| **Capability** | The identifier still declares the `use_cases` its role needs. Asserted on `use_cases` and never on `type`, because a model typed `text2text` was measured to accept an image and describe it correctly. `use_cases` is authoritative and `type` is not | Fatal |
| **Price drift** | The catalog price differs from the manifest price | Warning. A price change breaks the cost report rather than the demonstration, but silent drift is how a cost report becomes fiction |

**Identifier casing is load bearing, and the preflight is where that is enforced.** The catalog's
human readable `name` differs from the callable `model_id`, inconsistently: one identifier doubles
its vendor prefix, another is entirely lowercase, a third uses an underscore where the display name
uses a dot. Both the manifest and the preflight read `flavors[].model_id` and never `name`. Reading
`name` produces a typo that returns a 404 at run time and looks like a deprecation.

The catalog fetch needs no credential. It reads
`https://tokenfactory.nebius.com/api/public/models_info`, which along with the API's OpenAPI
description is treated as the only authoritative source, because **VERIFIED:** the prose
documentation is materially stale in places, still describing a model flavour whose identifiers were
all deleted, and citing vision model identifiers that do not exist in the catalog.

### 7.3 How it is wired in

| Stage | Invocation | On failure |
| --- | --- | --- |
| Build and deploy | `orimera-preflight` | Non zero exit fails the build. A deployment that cannot reach its models is not deployed |
| Continuous integration, offline | `orimera-preflight --catalog-file <snapshot>` | Runs against a committed catalog snapshot, so the test suite does not depend on the network |
| Scheduled through the unattended window | `orimera-preflight --json` | Feeds the weekly catalog diff described in section 9 |

**VERIFIED by execution 2026-08-27:** every model identifier in the manifest resolved against the
live catalog, 30 entries total. No role is pointing at a removed model.

### 7.4 Three honest gaps

1. **A catalog that cannot be reached is reported as a failure, exit 1.** That is correct for a
   build: a preflight that passes when it could not check anything is worthless. It is wrong for a
   scheduled check, where it turns a transient network blip into a page at three in the morning. The
   fix is a retry with backoff before alerting, distinguishing "the catalog says the model is gone"
   from "the catalog did not answer". **OPEN**, not implemented.
2. **The embedding role has no same tier fallback.** It is the only embedding typed model in the
   catalog. The preflight can detect its removal but nothing can recover from it, because
   substituting a model from a different vector space would silently poison every stored vector. The
   candidate mitigation is to precompute and freeze every embedding ahead of deployment so the
   demonstration never calls the embedding endpoint at all. That is probably the right answer and it
   has not been designed. **OPEN**, and it is the weakest point in the plan.
3. **The runtime fallback path is specified and not exercised.** The design calls for continuous
   integration to force the primary identifier to fail on every build so that the fallback is known
   good rather than theoretical. A fallback that has never executed is not a mitigation. **OPEN**,
   not implemented.

**What the mitigations buy, stated honestly:** with fallbacks in place, a deprecation during the
unattended window degrades answer quality rather than killing the demonstration. Degradation, not
death. That is the accurate description and it is the one to use wherever this project is described.

---

## 8. Cost control

Expected total infrastructure cost is roughly **$275 to $600 across 3.7 months**, dominated by
hosting uptime rather than by inference.

### 8.1 Inference spend is bounded by the platform, not by discipline

**VERIFIED from the billing console:** Token Factory is prepaid. API usage is charged against a
balance, top up is a manual action, and no automatic top up is offered. **Token Factory spend
therefore cannot exceed the balance**, which is a structural cap rather than a policy.

Measured against that: ingesting **1,000 photographs costs about $0.83**, and a conversational turn
at 15,000 tokens of context costs roughly $0.001 on the cheap reasoning tier. The prepaid balance on
the account is ample for the corpus and the unattended window at those unit costs. Inference is not
where this project's money goes.

### 8.2 Trap one: a forgotten GPU virtual machine

This is the realistic way the spend goes from small to embarrassing. An on demand L40S is **$32 to
$37 per day**. An H100 is **$92 per day**. Two forgotten weeks on the smaller card exceeds the entire
expected project budget.

**VERIFIED, and it is the non-obvious part:** GPU quotas count a virtual machine from creation to
deletion, **running or stopped**. Stopping the machine does not release the quota, so a stopped GPU
virtual machine both accrues attached storage cost and blocks the next job from starting. "I stopped
it" is not the same as "I deleted it".

Controls:

| Control | What it prevents |
| --- | --- |
| An auto-stop script on every GPU virtual machine | The overnight forget |
| Checkpoint reconstruction every 5,000 iterations | Makes preemptible instances genuinely usable, which is where the price difference is |
| Prefer Serverless **Jobs**, which self terminate, over endpoints, with a conservative timeout | Removes the class of failure entirely for the work that fits the shape |
| Lifecycle rules deleting reconstruction intermediates after 7 days | Silent storage growth from artifacts nobody will open again |
| A billing alert at $300 | The backstop for everything the other four missed |

**Reconstruction is a one time per scene cost.** Three to five scenes reconstructed once ahead of
deployment and cached as static assets is bounded and affordable. Reconstructing on demand during the
unattended window is neither, and it is also forbidden by the boundary in section 2: the hosted
demonstration must not depend on a long lived GPU job.

### 8.3 Trap two: managed PostgreSQL

**Roughly +$755 across the project period**, for a database that holds under a gigabyte, against
**$0 marginal cost** for a process on a host that has to exist anyway. This is the on-brand, obvious,
wrong choice, and it is wrong by more than the entire expected inference spend. The full reasoning is
in section 3.

It is named as a trap rather than merely rejected because it is the choice a reasonable person makes
by default. "Use the managed database" is good advice in almost every other context. It is bad advice
for a single tenant demonstration with a sub-gigabyte database and a fixed 3.7 month lifetime.

### 8.4 Where the money actually goes

| Line | Order of magnitude |
| --- | --- |
| The API and database host, running continuously across the window | Tens of dollars per month, and the largest single line |
| Object storage and egress | Small, and reduced further by an edge cache |
| Reconstruction GPU time, one time ahead of deployment | Bounded by scene count, and the line with the highest variance if the controls in 8.2 are not in place |
| Token Factory inference | Under a dollar for the corpus, capped by a prepaid balance |
| Static client hosting | Zero on the free tier |

---

## 9. Unattended operation

### 9.1 The premise

For 46 days there is no operator watching. Every control below exists to convert a class of silent
failure into either automatic recovery or an alert that reaches a person's phone. A dead URL is not
a degraded experience, it is the entire product gone, because everything the application does sits
behind it and nobody is present to notice.

### 9.2 What is monitored

| Signal | Method | Frequency | On failure |
| --- | --- | --- | --- |
| Process liveness | External check against `/healthz` from outside the deployment | Every 5 minutes | Alert to a phone after two consecutive failures. Two, not one, so a single dropped packet does not page |
| Dependency readiness | External check against `/readyz` | Every 15 minutes | Alert. Distinguishes "the API is up but the database is gone" from "everything is gone", which are different playbooks |
| Model catalog integrity | Scheduled `orimera-preflight`, diffing the live catalog against the manifest | Daily, and included in the weekly human check | Alert naming the identifier and the role. This is the only signal that catches a withdrawal, and a health ping succeeds right up until the first query hits a removed model |
| Database backup freshness | Age of the newest dump object in storage | Daily | Alert. A backup job that silently stopped is indistinguishable from one that is working, until it is needed |
| Spend | Billing alert at $300 | Continuous | Alert, and investigate for a forgotten GPU machine first, per section 8.2 |
| Everything the automation misses | A named person loading the application, walking one scene and asking one question | Weekly through the unattended window | Judgement |

**OPEN: the person doing the weekly check is not named.** This is the least technical item in the
document and it is not the least likely to be the one that fails. Seven weekends is a long time for
something to drift in a way no automated check was written to notice.

### 9.3 What happens on failure

| Failure | Automatic response | Manual response | Worst case |
| --- | --- | --- | --- |
| API process dies | Host restart policy restarts it | None needed unless it recurs | Minutes of downtime |
| Host dies | None. This is the gap the platform does not fill | Redeploy from the one command path, restore the newest nightly dump | Hours of downtime and up to 24 hours of ingest data loss. Acceptable, because the corpus is static during the window and the dump holds it |
| Database corruption or accidental data loss | None | Restore from the nightly dump | Same as above |
| A model identifier is withdrawn | Runtime failover to the declared fallback for that role, on a 404 class error | Update the manifest and bump the pipeline version | Degraded answer quality. **Except for the embedding role, which has no fallback**, section 7.4 |
| Object storage unreachable | Edge cache continues serving whatever it holds | Investigate | Scenes that were already cached still load. Uncached scenes do not |
| Total backend loss | The static client build works with **zero backend**, serving a clearly labelled recorded tour | Redeploy the backend | The application is still explorable. It is explicitly labelled as a recording, because presenting it as the live application would be dishonest and a user who noticed would rightly discount everything else |

### 9.4 The recovery paths that have to be real

Three of the responses above are only worth writing down if they have actually been executed at least
once.

- **A one command redeploy, run from a clean shell.** A redeploy path that has never been run from
  scratch is not a recovery path, it is a hypothesis. **OPEN**, not written.
- **A restore from the nightly dump, performed once and timed.** An untested backup is a backup with
  an unknown restore time and an unknown success probability. **OPEN**, not performed.
- **The zero backend static build, loaded with the API deliberately switched off.** **OPEN**, not
  built.

Each of these is cheap to do once and worthless to describe without doing.

---

## 10. Choosing the target: options, tradeoffs and the criteria that settle it

The topology in section 2 is settled. The concrete target is not, and pretending otherwise would put
a decision in this document that nobody has made.

### 10.1 The API and database host

| Option | For | Against | Cost |
| --- | --- | --- | --- |
| **Nebius Compute virtual machine, small general purpose shape, network SSD volume, restart policy** (the recommendation on record) | Restart policy gives automatic recovery from process death. Volumes are documented and ordinary. Database and API in one consistency domain with no network hop | Manual host provisioning. No automatic recovery from host death, which is why the backup and redeploy paths in section 9.4 matter | About $36 per month |
| **Nebius Serverless AI endpoint with a co-located database container** | Scores best of these options on platform alignment | Preview grade with no service level, no automatic retry or recovery, and a documented typical lifetime of hours to days. Volume mounting is documented for jobs and **undocumented for endpoints**, so data durability rests on an assumption | Identical, about $36 per month. Serverless AI applies Compute pricing |
| **Nebius Managed PostgreSQL plus a separate API host** | Managed backups, managed upgrades, the professionally normal answer | Roughly +$755 across the project for a sub-gigabyte database. Splits one consistency domain across a network boundary, which section 3 argues against on deletion correctness grounds, not only on cost | +$204 per month |
| **A non-Nebius host such as Fly.io** | Cheap and technically adequate | Does not satisfy the project's platform constraint. Retained only as an unused break-glass configuration | Low |

### 10.2 The static client host

| Option | For | Against |
| --- | --- | --- |
| **Vercel Hobby, static** (the current default) | Zero cost, global edge, no server to die | 100 MB static upload cap and a 45 minute build cap, both **VERIFIED**. Neither binds once assets live in object storage, section 4.2 |
| **Cloudflare Workers Static Assets** | Equivalent, and pairs naturally with a Cloudflare cache in front of the Nebius origin | One more account and one more thing to configure |
| **Serve the client from the API host** | One fewer component | Couples the client's availability to the backend's, which discards the zero backend fallback in section 9.3. Rejected on that ground alone |

### 10.3 The criteria that settle it

In priority order, because they conflict and the order is the decision.

1. **Survives 46 days unattended.** Any option whose documented typical lifetime is shorter than the
   window is disqualified regardless of its other merits. This is the criterion that separates the
   first two rows of 10.1.
2. **The platform constraint stays literally true.** The system must run on Nebius Token Factory or
   Nebius AI Cloud. This disqualifies the non-Nebius row and is why the asset origin stays on Nebius
   even where an alternative would be marginally cheaper.
3. **One consistency domain for the database and the application.** Deletion correctness, section 3.
   This disqualifies the managed database row independently of its price.
4. **Total cost stays inside the $275 to $600 envelope**, with no line item exceeding the expected
   inference spend by an order of magnitude for no capability gain.
5. **Recovery is testable before the window opens.** An option whose failure path cannot be
   rehearsed before the operator stops watching is worth less than one that can, whatever its steady
   state numbers look like.

Applying 1 through 4 leaves the Compute virtual machine, which is why it is the recommendation on
record. It is not recorded as locked, because criterion 5 has not been exercised and because the
canary experiment in section 3.2 is still running.

### 10.4 What has to be settled, and by when

| Question | Settled by | Deadline |
| --- | --- | --- |
| The cloud account and project | Provisioning it | Before the first deployment rehearsal |
| The domain name | Registering it and pointing it | Before the deployment rehearsal, and early enough that DNS and certificate issuance are not on the critical path on the day the window opens |
| Compute virtual machine or Serverless endpoint | The canary experiment's outage log, read against criterion 1 | At the deployment rehearsal, not on the day the window opens |
| Whether the health endpoint, the redeploy command and the zero backend fallback exist | Writing them | Before the deployment rehearsal, since the rehearsal is what tests them |
| Who performs the weekly check | Asking a person and getting a yes | Before the window opens |

**A deployment rehearsal is scheduled before the window opens, not on the day it opens.** The entire
plan above is untested until the application has been deployed once, killed deliberately, and
recovered from the documented path. Everything in sections 6, 9 and 10 is a hypothesis until that
has happened at least once with a stopwatch running.

---

## 11. Consolidated open items

| # | Item | Resolved by |
| --- | --- | --- |
| D-1 | ~~No HTTP service exists~~ **CLOSED.** The service exists and both health endpoints are implemented. What is NOT asserted anywhere is that `/readyz`'s schema check reports a stale schema rather than a missing one; that has no positive test | Writing one |
| D-2 | The one command redeploy has never been run from a clean shell | Running it |
| D-3 | The nightly dump has never been restored | Restoring one and timing it |
| D-4 | The zero backend static fallback has not been built | Building it and loading it with the API off |
| D-5 | Preflight treats an unreachable catalog as a failure, correct for a build and wrong for a scheduled check | Retry with backoff, and distinguish the two outcomes in the alert |
| D-6 | The embedding role has no fallback and no recovery path | Design the precompute and freeze approach, or accept a single point dependency and say so |
| D-7 | The runtime fallback path has never executed | Force the primary to fail in continuous integration |
| D-8 | Whether the renderer's asset loader issues range requests is unobserved | Load a scene with the network panel open |
| D-9 | The cloud account, project, region placement and domain are unchosen | Section 10.4. This is the only thing between the artefacts in section 1 and a running deployment |
| D-12 | ~~The container image has never been built~~ **CLOSED 2026-08-29.** Built, 222 MB, and run: uvicorn serves, the healthcheck passes, both console scripts run, an upload through it returned 202 and its worker drained the queue, and a bad connection string makes it refuse to start. What is still unobserved is the image running anywhere but this machine | Section 10.4, which is D-9 |
| D-13 | There is no reverse proxy and no static client host in the composition | Choosing one, which is D-9 |
| D-10 | Nobody is named for the weekly check through the unattended window | Asking a person |
| D-11 | Whether a preview grade service survives the window at all | The canary endpoint's outage log |

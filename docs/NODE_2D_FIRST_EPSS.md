# NODE-2D — FIRST EPSS Production Adapter

## Goal

Admit FIRST EPSS as BAYKUSH Intelligence Node's production exploit-probability source without turning a predictive score into observed exploitation, severity, risk, attack volume, or remediation priority.

NODE-2D deliberately replaces the earlier CİTEM pattern of querying a bounded FIRST API page with a streaming ingestion of FIRST's official daily complete CSV artifact. The complete daily dataset is validated, but only an explicitly declared bounded high-signal population is persisted in NODE-2D.

The phase preserves four different things that must not be conflated:

1. source acquisition — the complete FIRST daily artifact;
2. dataset integrity — the complete artifact must parse and validate;
3. BAYKUSH capture profile — the retained subset is intentionally bounded;
4. canonical semantics — retained records are exploitation-probability scores, not exploitation observations.

## Runtime flow

```text
FIRST EPSS daily CSV.gz
  -> controlled HTTPS artifact transport
  -> allowlisted redirect validation
  -> compressed-byte bound + SHA-256
  -> gzip validation/decompression
  -> decompressed-byte bound + SHA-256
  -> model metadata extraction
  -> streaming CSV validation
  -> duplicate-CVE rejection
  -> deterministic bounded top-K selection
  -> dataset manifest + selected score rows
  -> immutable raw_source_records
  -> normalization_jobs
  -> EXPLOIT_PROBABILITY_SCORE
  -> CVE entity
```

The collector never materializes the full daily score population as JavaScript objects. It streams the complete artifact and retains at most the configured top-K score candidates plus one dataset manifest.

## Official delivery mechanism

NODE-2D uses the stable FIRST/Empirical Security daily bulk artifact:

```text
https://epss.empiricalsecurity.com/epss_scores-current.csv.gz
```

The FIRST EPSS API is not used for bulk synchronization. FIRST documents the API as a lookup/small-batch interface and recommends the daily CSV or historical repository for local/batch synchronization.

The current URL redirects to the day's dated artifact. NODE-2D follows redirects only through an explicit HTTPS endpoint allowlist.

## Source semantics

Source definition:

```text
source_key                  FIRST_EPSS
source_class                EXPLOIT_PROBABILITY
observation_basis           SCORED
authority_type              INDUSTRY_SCORING_SYSTEM
collection_mode             SNAPSHOT
default_poll_interval       21600 seconds
minimum_poll_interval       3600 seconds
supports_historical         true
recovery_strategy           HISTORICAL_QUERY
historical_max_window       86400 seconds
auth_requirement            NONE
enabled_by_default           false
adapter_version              first-epss-adapter-v1
normalization_version        first-epss-normalization-v1
semantic_contract_version    first-epss-semantics-v1
checkpoint_schema_version    first-epss-checkpoint-v1
```

EPSS represents a source-published probability estimate associated with a CVE for a score date. It does not establish:

- an exploitation event;
- an attack or attack count;
- a victim or victim count;
- active exploitation proof;
- CVSS or vulnerability severity;
- asset exposure;
- business impact;
- business risk;
- remediation priority;
- BAYKUSH Global Priority;
- a current global cyber threat level.

The central invariant is:

> EPSS score movement is not observed exploitation movement.

## Capture profile

NODE-2D retains the existing bounded CİTEM high-signal population as an explicit source-capture contract:

```text
profile_key       EPSS_HIGH_SIGNAL_V1
minimum_epss      0.10
maximum_records   2500
ordering          epss DESC, percentile DESC, CVE ASC
```

The threshold is a BAYKUSH storage/capture choice. It is not an EPSS-defined danger threshold.

A CVE absent from NODE-2D's retained EPSS score population must never be interpreted as score zero. Absence may mean:

- EPSS below 0.10;
- EPSS at or above 0.10 but outside the top 2500;
- no source coverage for the relevant dataset date.

Therefore:

> Unknown / not captured is not zero.

## Deterministic top-K

The complete dataset is streamed through a bounded min-heap rather than collected and sorted in memory.

Complexity is approximately:

```text
O(N log K)
```

where `N` is the complete daily EPSS population and `K` is at most 2500.

Quality order is deterministic:

1. higher EPSS score;
2. higher percentile;
3. lexically smaller CVE ID.

The CVE tie-break prevents provider row order, stream chunking, or platform differences from changing the retained population.

## Artifact transport

NODE-2D adds `src/http/source-artifact.ts`, a reusable bounded artifact transport distinct from the JSON transport.

Controls include:

- HTTPS only;
- URL credentials rejected;
- explicit hostname/path allowlist;
- bounded redirect count;
- each redirect revalidated;
- HTTP downgrade rejected;
- cross-host sensitive request headers stripped;
- timeout inherited from Node source HTTP configuration;
- compressed `Content-Length` preflight bound;
- streaming compressed-byte bound;
- accepted content-type validation;
- provider rate-limit/5xx classification;
- complete-body consumption requirement.

Cross-host redirects strip at least:

```text
authorization
proxy-authorization
cookie
apikey
api-key
auth-key
```

EPSS itself requires no credential, but the transport remains safe for reuse.

## Compression bounds

A compressed response limit alone is insufficient because a small compressed artifact can expand into a very large body.

NODE-2D therefore enforces both:

```text
max compressed bytes      32 MiB
max decompressed bytes   128 MiB
```

Additional parser safety bounds include:

```text
max dataset rows          1,000,000
max columns               32
max CSV record bytes      4 KiB
max metadata line bytes   4 KiB
```

These are parser/infrastructure safety bounds, not intelligence semantics.

## Gzip validation

Before decompression the artifact must begin with the gzip magic bytes.

The Node then uses `node:zlib` for streaming decompression. Corrupt or truncated gzip data is treated as a retryable provider/artifact failure rather than partially accepted evidence.

## CSV parser

NODE-2D uses the streaming `csv-parse` package. The parser does not buffer the complete daily dataset.

Required core columns are:

```text
cve
epss
percentile
```

Schema policy is:

> strict core, tolerant additive edges.

Future source columns are allowed within the column bound. For selected rows, unknown values remain in `sourceExtras` in raw source truth. They are not automatically promoted to canonical facts.

## Metadata line

Current EPSS files contain a leading comment describing the model version and score date, for example:

```text
#model_version:v2026.06.15,score_date:2026-08-12T00:00:00+0000
```

NODE-2D extracts:

- source-native model version;
- normalized score timestamp;
- dataset date;
- exact source header string.

The normalizer does not hard-code EPSS v5. Future source model versions are accepted as source-native metadata.

A new EPSS model version does not itself require a BAYKUSH normalization-version bump. A BAYKUSH normalization/semantic mapping change does.

## Model-version boundaries

Historical EPSS analysis can cross methodology boundaries. FIRST documents model-version dates and warns that a score shift at a model transition can reflect model methodology rather than a change in the vulnerability itself.

NODE-2D therefore preserves `modelVersion` on every retained score and dataset manifest. NODE-3 can later require same-model comparisons for selected movement metrics.

## Dataset-level integrity

NODE-2D intentionally fails closed for malformed source rows.

The complete dataset fails if any row violates the required contract, including:

- invalid CVE ID;
- EPSS outside `[0,1]`;
- percentile outside `[0,1]`;
- missing required core field;
- duplicate CVE ID;
- parser record/row/column bounds;
- invalid source metadata.

This differs from the earlier CİTEM adapter, which could skip malformed rows.

The reason is selection integrity: a skipped malformed row could have contained a score high enough to change the retained top-K population.

> Dataset-level scoring sources require dataset-level integrity.

No raw score or checkpoint is persisted until the complete artifact has been successfully parsed.

## Valid zero

A valid complete dataset may theoretically contain zero rows qualifying for the BAYKUSH capture profile.

That state is valid:

```text
totalRows      > 0
qualifiedRows  = 0
selectedRows   = 0
```

The dataset manifest is still persisted and the run succeeds. This is an observed zero under the capture predicate, not a collection failure.

## Full dataset is not retained

NODE-2D does not store the entire compressed CSV artifact or every daily score row in PostgreSQL.

It preserves enough provenance to identify and verify the artifact:

- source URL/final URL;
- redirect chain;
- ETag/Last-Modified when provided;
- compressed artifact SHA-256;
- decompressed dataset-content SHA-256;
- selected-population SHA-256;
- model version;
- score date;
- total/qualified/selected row counts;
- capture profile;
- source header.

The deliberate tradeoff is that an unselected low-score CVE cannot be reconstructed later from Node raw history alone. Full historical score persistence/backfill remains out of NODE-2D scope.

## Dataset manifest

Every changed daily artifact produces one immutable raw record:

```text
source_record_id = dataset-manifest
```

The manifest contains:

```text
datasetDate
modelVersion
totalRows
qualifiedRows
selectedRows
captureProfile
compressedBytes
decompressedBytes
compressedArtifactSha256
datasetContentSha256
selectedPopulationSha256
sourceHeader
http.etag
http.lastModified
http.finalUrl
http.redirectChain
```

The manifest is collection/provenance metadata, not an intelligence assertion. Its normalizer intentionally returns zero canonical evidence records. The normalization job still succeeds with `canonical_records_written = 0`.

## Score raw identity

Each retained score uses:

```text
source_record_id = CVE ID
```

A persisted score payload contains:

```text
kind
cve
epss source string
percentile source string
scoreDate
modelVersion
datasetContentSha256
captureProfile
sourceExtras (when present)
```

Including `scoreDate` means the same numeric score on two different days remains two immutable source revisions, which is required for a daily time series.

Including the dataset content hash means a same-day corrected/reissued dataset can create a new source revision even if a particular numeric score did not change. The exact source artifact provenance therefore remains explicit.

## Idempotency

Raw idempotency remains the NODE-2A invariant:

```text
(source_definition_id, source_record_id, payload_sha256)
```

Therefore:

- same daily artifact + same score payload -> no new raw revision;
- next day + same numeric score -> new revision because score date changed;
- same day + corrected artifact -> new revision because dataset hash changed;
- changed score -> new revision.

When the adapter sees the same completed dataset date and same dataset-content hash as the checkpoint, it returns zero records before raw persistence.

## Canonical output

A retained EPSS score normalizes to:

```text
record_kind   = EXPLOIT_PROBABILITY_SCORE
canonical_key = epss:<CVE-ID>
```

The v1 entity list contains only:

```text
CVE
```

Canonical facts are deliberately narrow:

```text
epss.score
epss.percentile
epss.score_date
epss.score_date_precision
epss.model_version
epss.dataset_content_sha256
baykush.capture_profile
baykush.capture_minimum_epss
baykush.capture_max_records
```

NODE-2D does not manufacture:

```text
epss.risk
epss.severity
epss.priority
epss.attack_count
epss.active_exploitation
```

## Cross-source separation

The same CVE may exist simultaneously as:

```text
NVD       VULNERABILITY_RECORD
CISA KEV  KNOWN_EXPLOITED_VULNERABILITY
FIRST     EXPLOIT_PROBABILITY_SCORE
```

Each source keeps a different canonical key/record kind while sharing the global CVE entity. This preserves convergence without collapsing semantics.

EPSS cannot become a KEV assertion. CISA KEV cannot become an EPSS probability. NVD cannot become either merely because it references related data.

## Time model

For retained score evidence:

```text
received_at          Node receipt time
published_at         score date at date precision
effective_at         score date at date precision
upstream_updated_at  NULL
```

The raw source header preserves the provider's full score timestamp when one exists. The canonical fact `epss.score_date_precision = DATE` prevents the synthetic midnight database instant from being interpreted as an exact event time.

HTTP `Last-Modified` remains transport/manifest metadata and is not treated as row-level source semantics.

## Checkpoint

The v1 checkpoint is intentionally snapshot-oriented:

```text
{
  version: 1,
  completedDatasetDate,
  completedContentSha256,
  completedModelVersion,
  previousTotalRows,
  etag,
  lastModified
}
```

ETag and Last-Modified are optional transport accelerators, not canonical source truth.

## Work descriptor

Each run plans one current-snapshot work unit:

```text
{
  version: 1,
  mode: CURRENT,
  previousDatasetDate,
  previousContentSha256,
  previousModelVersion,
  previousTotalRows,
  ifNoneMatch,
  ifModifiedSince
}
```

The provider URL is fixed in code and is not stored as arbitrary operator-controlled work data.

## Conditional requests

If provider validators are available, NODE-2D sends `If-None-Match` and/or `If-Modified-Since`.

A valid HTTP 304:

- returns zero records;
- preserves the completed dataset checkpoint;
- updates validators when supplied;
- succeeds.

A 304 without a completed local dataset is a retryable provider inconsistency.

## Dataset regression

A current artifact with `datasetDate` older than the completed checkpoint is rejected as `SOURCE_SNAPSHOT_CHANGED`. Progress does not move backwards.

Under the same model version, a new dataset population less than 75% of the previous successful row count is also treated as a retryable snapshot-change anomaly. This guard is source-integrity protection, not threat inference.

A model-version change bypasses the same-model population guard because a methodology transition may legitimately change the scored population or distribution.

## Historical availability

FIRST publishes historical daily score files and therefore the source contract declares:

```text
supportsHistoricalRetrieval = true
recoveryStrategy = HISTORICAL_QUERY
```

NODE-2D v1 still performs only current snapshot admission. It does not automatically backfill missed days or download the full archive.

Historical orchestration, coverage-gap repair, and full historical measurements remain NODE-3 concerns.

Historical availability must not be confused with historical live collection coverage.

## Poll cadence

EPSS is published daily. NODE-2D polls every six hours by default with a one-hour minimum.

The shorter-than-daily polling interval prevents deployment/enable time from coupling the Node to an unknown daily publication instant. Checkpoint hashes and HTTP validators prevent unchanged daily artifacts from manufacturing repeated raw records.

## Failure model

Retryable classes include:

- network/transport failure;
- timeout;
- rate limit;
- provider 5xx;
- corrupt/truncated gzip artifact;
- source snapshot regression/change guard.

Fail-closed classes include:

- unsafe redirect;
- HTTPS downgrade;
- missing model metadata;
- missing required CSV columns;
- invalid CVE;
- invalid probability/percentile;
- duplicate CVE;
- row/column/decompressed payload bounds.

Retry policy uses the shared NODE-2A worker backoff infrastructure.

## Security boundary

EPSS needs no credential.

External artifact content is treated only as data. No CSV field is executed as shell, SQL, template, prompt, or code.

NODE-2D adds no AI path. Collection and normalization are deterministic.

## Database changes

NODE-2D requires no new database migration. Existing NODE-2A/NODE-2C tables already provide:

- source definitions;
- scheduling/health/checkpoints;
- immutable raw records;
- normalization jobs;
- immutable canonical evidence.

## Files

Primary implementation:

```text
src/http/source-artifact.ts
src/utils/bounded-top-k.ts
src/sources/first-epss.ts
src/sources/registry.ts
```

Tests/acceptance:

```text
tests/source-artifact.test.ts
tests/first-epss.test.ts
scripts/test-node2d.ts
```

Documentation:

```text
docs/NODE_2D_FIRST_EPSS.md
docs/SOURCE_ADMISSION_FIRST_EPSS.md
```

## Automated acceptance

CI covers:

- disabled-by-default source admission;
- source semantics and auth contract;
- current/future model-version metadata parsing;
- streaming gzip parsing;
- compressed and decompressed limits;
- safe and unsafe redirects;
- deterministic top-K selection;
- deterministic CVE tie-break;
- additive-column preservation;
- duplicate CVE rejection;
- malformed score rejection;
- corrupt gzip rejection;
- valid zero qualifying population;
- canonical probability semantics;
- manifest -> zero canonical records;
- PostgreSQL raw-to-canonical flow;
- bootstrap/live run distinction;
- daily immutable revision behavior;
- same-artifact idempotency;
- zero normalization failures.

CI is network-independent.

## Manual live acceptance

Before merge, an operator should run one live FIRST smoke test with the production adapter and verify:

```text
FIRST_EPSS enabled explicitly
health = HEALTHY
first run = BOOTSTRAP / INITIAL_BOOTSTRAP
latest run = SUCCEEDED
normalization failures = 0
manifest exists
modelVersion present
datasetDate valid
totalRows > 0
selectedRows <= 2500
all persisted score rows >= 0.10
canonical score count = selectedRows
canonical kind only EXPLOIT_PROBABILITY_SCORE
raw/canonical provenance reversible
no risk/severity/attack facts
```

The current model is expected to be the source's live EPSS model family, but acceptance does not hard-code a particular model version.

After live acceptance the source should be disabled again unless the environment is intentionally operating production collection.

## Explicitly out of scope

NODE-2D does not add:

- full historical EPSS backfill;
- full daily population persistence;
- object storage for original CSV artifacts;
- EPSS REST API bulk synchronization;
- per-CVE on-demand API enrichment;
- CVSS joins;
- KEV joins;
- asset inventory matching;
- risk scoring;
- remediation priority;
- global threat scoring;
- AI interpretation;
- daily distributions;
- score movers;
- coverage measurements;
- CİTEM Global View reads.

Those are later history/measurement/projection concerns.

## NODE-3 handoff

NODE-2D intentionally preserves the fields NODE-3 needs to build trustworthy score history:

```text
scoreDate
modelVersion
epss
percentile
datasetContentSha256
captureProfile
```

NODE-3 can therefore distinguish:

- source-effective date;
- source model version;
- capture-profile boundaries;
- same-model score movement;
- historical data availability from actual live collection coverage.

NODE-2D ends at evidence. NODE-3 begins measurements.

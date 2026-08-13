# NODE-4G final acceptance report

Date: 2026-08-13 (Europe/Warsaw). No PR was merged. No temporary integration branch was pushed.

## Reviewed heads and integration

- Node PR #11 old reviewed head: `22985d2642c5ca56f2e153aecc44bc1197e0c01b`.
- Node PR #11 acceptance head: `47e4471` (`b351928` provenance semantics; `47e4471` authenticated API/measurement Compose wiring).
- Node PR #12 reviewed head before this report: `e198e783b10c8408604a0cdbe6a113f66d58cf9f`.
- CİTEM PR #49 old reviewed head: `bbcc3b30cd11c0a51106cfb53f7d5992928a9989`.
- CİTEM PR #49 acceptance head: `21266b0` (`9489656` provenance schema/page test; `21266b0` owner-independence regression).
- Local-only integration order: `origin/main` -> PR #11 -> PR #12.
- Integration result: **PASS**. Git `ort` merged both heads without conflicts. Final local-only integration head: `d5ea8f8` (not pushed).

## Evidence by execution category

| Category | Status | Evidence |
| --- | --- | --- |
| AUTOMATED CI — PR #12 report commit | PASS | GitHub NODE validation run `31724169477` passed for `3034273`. |
| AUTOMATED CI — PR #11 acceptance head | PASS | GitHub NODE validation run `31723305191` passed for `47e4471`. |
| AUTOMATED CI — CİTEM acceptance head | PASS | GitHub validation run `31723867003` and Vercel preview passed for `21266b0`. |
| LOCAL CODE — combined Node | PASS | `npm run lint`; `npm run typecheck`; `npm test` (23 files, 151 tests); `npm run build`. |
| LOCAL CODE — PR #11 | PASS | `npm run lint`; `npm run typecheck`; `npm test` (21 files, 145 tests); `npm run build`; `docker compose config --quiet`. |
| LOCAL CODE — CİTEM | PASS | `npm run lint` (0 errors, 8 pre-existing warnings); `npx tsc --noEmit --incremental false`; `npm test` (132 files, 940 tests); `npm run build`. |
| LOCAL POSTGRESQL | BLOCKED | `npm run db:migrate` against `127.0.0.1:5432` returned `ECONNREFUSED`; no PostgreSQL binaries/server are installed or listening. |
| LOCAL DOCKER | BLOCKED | Compose config renders successfully, but Docker API access is denied at `/var/run/docker.sock`; passwordless `sudo` is unavailable under the host no-new-privileges policy. Image build and stack startup were not performed. |
| REAL PROVIDER NVD | BLOCKED | Deterministic plan produced one interval segment for `2026-08-12T00:00:00Z` through `2026-08-13T00:00:00Z`; execution requires the blocked PostgreSQL/Docker stack. No provider request or result count is claimed. |
| REAL PROVIDER EPSS | BLOCKED | Deterministic plan produced dated dataset segment `2026-08-12`; execution requires the blocked PostgreSQL/Docker stack. No artifact availability, gzip, model, hash, population, or checkpoint result is claimed. |
| REAL CİTEM -> NODE HTTP | BLOCKED | No authenticated Node API could be started without Docker/PostgreSQL. |
| REAL BROWSER | BLOCKED | No real Node API was available, and no legitimate local authenticated Supabase/browser fixture was established. No auth bypass was added. |
| DETERMINISTIC FIXTURE — provenance | PASS | Node `tests/node4-provenance.test.ts` proves registered contract metadata is returned with the bounded input contract. CİTEM `tests/node-provenance-page.test.tsx` proves schema passthrough and rendering of contract/calculation versions plus `represents`/`doesNotRepresent`. |
| DETERMINISTIC FIXTURE — null vs zero | PASS | CİTEM `src/components/techint/node-series-chart.test.tsx` proves null is an unavailable gap and covered zero remains zero. |
| DETERMINISTIC FIXTURE — comparison | PASS | Node summary/comparison tests preserve LAST_VALUE, SUM_EVENTS, exact-distinct and unsupported-scalar rules; CİTEM contract tests accept Node-owned unavailable comparison state and do not recompute it. |
| DETERMINISTIC FIXTURE — authority | PASS | CİTEM authority tests cover all five Node-authoritative sources and start paths including enable/resume, manual/due claim, sync, collector enable/rotation/tick and work claim. |
| DETERMINISTIC FIXTURE — owner independence | PASS | CİTEM `src/lib/baykush-node/queries.test.ts` proves status/measurement requests contain no user or owner identifier. |

## Real-stack acceptance status

- API authentication: **BLOCKED** (unit/API boundary tests PASS; real stack not started).
- PostgreSQL read API: **BLOCKED**.
- NVD historical acquisition and live-checkpoint equality: **BLOCKED**.
- NVD restart/lease: **NOT_PERFORMED**. The PostgreSQL regression exists but could not run locally.
- EPSS historical acquisition and live-checkpoint equality: **BLOCKED**.
- Historical normalization and measurement projection: **NOT_PERFORMED**.
- CİTEM real Node HTTP and browser ranges 24H/7D/30D: **BLOCKED**.
- CİTEM-closed collection: **NOT_PERFORMED**.
- Node outage real-process test: **NOT_PERFORMED**; deterministic client/page failure handling is covered separately.

## Acceptance matrix

- NODE-4A: **FAIL for final acceptance** — implementation and local automated tests pass, but real authenticated stack and new-head CI evidence are incomplete.
- NODE-4B: **FAIL for final acceptance** — executor/planners and deterministic tests exist, but PostgreSQL and real NVD/EPSS execution are blocked.
- NODE-4C: **FAIL for final acceptance** — semantic tests pass, but real PostgreSQL-backed endpoints were not exercised.
- NODE-4D: **FAIL for final acceptance** — server-only client tests pass, but real CİTEM -> Node HTTP is blocked.
- NODE-4E: **FAIL for final acceptance** — deterministic UI semantics pass, but real 24H/7D/30D browser acceptance is blocked.
- NODE-4F: **FAIL for final acceptance** — provenance and authority tests pass, but real drill-down is blocked.
- NODE-4G: **FAIL** — the essential real-stack path was not exercised.

## 2026-08-13 real-stack continuation

The prior blocked results above are superseded by this isolated real-stack run. A disposable Compose project, `baykush-node4-acceptance`, was built from current `origin/main`, PR #11, then PR #12. It used `127.0.0.1:18080`, an unbound isolated PostgreSQL service, an isolated volume, and an ephemeral server-only API token. The pre-existing `baykush-intel-node-*` project was not mutated.

| Real evidence | Result |
| --- | --- |
| Stack | PASS: PostgreSQL and API healthy; scheduler, worker, normalizer, measurement, and backfill running with fresh heartbeats. |
| Authentication | PASS: health 200 without auth; sources 401 missing/wrong token and 200 with the ephemeral token. No token appeared in response bodies or logs. |
| PostgreSQL read API | PASS: sources/status, summary, catalog, measurements, coverage, comparison, changes, and records exercised. 24H/7D/30D changes passed; limit 25 was honored; malformed cursor and limit 101 returned 400. Missing coverage remained null/unavailable. |
| Live Node collection | PASS: CISA KEV accepted/inserted 1,666; NVD 2,017; FIRST EPSS 2,501. This was Node authority collection, not CİTEM legacy collection. |
| Real NVD historical | PASS: 2026-08-12 UTC segment accepted 1,482 and inserted 569; `collection_runs.purpose=HISTORICAL_BACKFILL`; live checkpoint JSON/revision/run ID were identical before and after. |
| NVD restart/lease | PASS: a separate 2026-08-11 segment was stopped at RUNNING attempt 1 with zero persisted records, reclaimed after lease expiry as attempt 2, and completed with 1,170 accepted/inserted. One idempotency key/run and zero duplicate raw-truth groups remained; live checkpoint stayed identical. |
| Real FIRST EPSS historical | PASS after defect fix: dated `epss_scores-2026-08-12.csv.gz`, model `v2026.06.15`, 2,501 accepted/inserted. Dataset and selected-population SHA-256 values were persisted. Capture remained `EPSS_HIGH_SIGNAL_V1`, minimum 0.1, maximum 2,500; this is not the full EPSS population. Live checkpoint stayed identical. |
| Normalization/measurement | PASS: real raw records flowed through normalization to canonical evidence and measurement facts/buckets; provenance revision `455cddea-e1d2-4690-970f-d27802079b65` returned 27 bounded inputs and no raw payload. |
| Real CİTEM HTTP | PASS: PR #49 production queries and Zod schemas passed against the isolated Node for 24H, 7D, and 30D for status, measurements, changes, and comparisons. No CİTEM user ID was sent. |
| Browser | BLOCKED: no legitimate browser test account/session fixture exists. No bypass or production user was created. |
| Collection authority | PASS: 17 authority tests covered all five sources and enable/resume, sync, activation/tick, manual/due/work claim paths under `NODE_AUTHORITY`. |
| Node outage | PASS: stopping only the isolated API produced typed CİTEM `UNAVAILABLE`; authority stayed blocked; restart restored all range queries. |
| CİTEM closed while Node collects | PASS by server/process independence: NVD restart acquisition, normalization, and measurement ran with no CİTEM server process required; subsequent CİTEM HTTP queries observed Node data. |

Two real defects were fixed only on existing PR #12: status serialization of PostgreSQL timestamps (`f4e6fb1`) and PostgreSQL `date` conversion for historical EPSS descriptors (`4ff3f79`). Both were pushed to the existing branch; no replacement PR was created. PR #12 validation run `31726691148` passed at `4ff3f7977916e3af94577fe3a5bb7742f2e83479`.

## Final matrix

- NODE-4A: **PASS**
- NODE-4B: **PASS**
- NODE-4C: **PASS**
- NODE-4D: **PASS**
- NODE-4E: **FAIL** (real browser authentication unavailable)
- NODE-4F: **PASS**
- NODE-4G: **FAIL** (browser gate remains blocked)

Final reviewed heads: PR #11 `47e447189290ace7083bca22c8899d077a2698eb` (CI PASS), PR #12 `4ff3f7977916e3af94577fe3a5bb7742f2e83479` (CI PASS), CİTEM PR #49 `21266b06ca7e2f62646221c8107c583929f815b2` (CI and Vercel PASS). The eventual order remains #11, then #12, then #49. None was merged.

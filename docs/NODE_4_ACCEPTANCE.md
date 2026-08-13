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
| AUTOMATED CI — PR #12 reviewed head | PASS | GitHub NODE validation was independently green at the supplied reviewed head before this pass. A new run is required for this report commit. |
| AUTOMATED CI — PR #11 acceptance head | NOT_PERFORMED | Local validation passed; the new GitHub run must finish before CI can be called PASS. |
| AUTOMATED CI — CİTEM acceptance head | NOT_PERFORMED | Local validation passed; GitHub and Vercel must finish before they can be called PASS. |
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

## Required continuation

Run the existing Compose stack on a host with Docker socket access, preserve one ephemeral server-only token across Node and CİTEM, then execute PostgreSQL gates, authenticated read APIs, bounded real NVD/EPSS backfills, checkpoint equality, normalization/measurement, CİTEM HTTP/browser, outage and CİTEM-closed acceptance. Do not reinterpret this report as provider or real-stack PASS.

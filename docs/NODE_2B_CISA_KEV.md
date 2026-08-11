# NODE-2B — CISA KEV Production Adapter

## Goal

Admit the first real production intelligence source into BAYKUSH Intelligence Node: CISA Known Exploited Vulnerabilities (KEV).

NODE-2B proves that the NODE-2A runtime can collect a real authoritative full-snapshot source while preserving source truth, semantic boundaries, revisions, provenance, and bootstrap/live separation.

## Runtime flow

```text
CISA KEV
  -> official CISA retrieval channel
  -> bounded HTTPS snapshot
  -> exact-body SHA-256
  -> fail-closed full-catalog validation
  -> one bounded snapshot work unit
  -> batched immutable raw persistence
  -> normalization jobs
  -> KNOWN_EXPLOITED_VULNERABILITY canonical evidence
  -> raw provenance
```

## Collection design

- one upstream snapshot is downloaded once per changed poll;
- max response size: 8 MiB;
- max catalog entries: 5000;
- KEV adapter bound: 5001 records per work unit (5000 entries + one manifest);
- runtime global hard cap: 10000 records per work unit;
- default polling: hourly;
- minimum configured polling: 15 minutes;
- ETag and Last-Modified are used only with the retrieval channel that issued them;
- a same-body SHA-256 is treated as unchanged even if an HTTP validator changes.

KEV is not paginated upstream. Re-downloading the same catalog in 100-record chunks would multiply network traffic and risk mixed snapshots. NODE-2B therefore preserves bounded-work semantics with one source-specific bounded snapshot unit rather than provider-fake pagination.

## Atomic persistence

Raw persistence uses multi-row batches of 250 records, but all batches for a work unit remain inside the same PostgreSQL transaction as:

- raw record insertion;
- normalization job creation;
- checkpoint advancement;
- work/run completion state.

If any batch fails, the transaction rolls back. A partially persisted KEV snapshot cannot advance the durable checkpoint.

## Revision model

KEV entry identity is the CVE ID. Raw idempotency remains:

```text
(source_definition_id, source_record_id, payload_sha256)
```

Catalog-level fields are not copied into every entry payload. Therefore a new `catalogVersion` does not create thousands of false CVE revisions.

Changed snapshots also write an immutable `__catalog_manifest__` record containing the snapshot fingerprint and complete sorted membership list.

## Canonical model

Each entry yields one canonical record:

```text
KNOWN_EXPLOITED_VULNERABILITY
cve:<CVE-ID>
```

Date-only CISA fields remain date-only facts and do not become fabricated midnight timestamps.

`knownRansomwareCampaignUse = Unknown` is preserved exactly as source data and is never converted to false/no.

## Retrieval lineage

The preferred retrieval path is CISA's official `cisagov/kev-data` repository. The fallback is the canonical CISA JSON feed. Both are CISA-controlled retrieval channels and share one `upstreamOriginKey = CISA_KEV`; they must never create fake source convergence.

## Acceptance

NODE-2B automated acceptance validates:

1. CISA remains disabled by default;
2. first collection is `BOOTSTRAP / INITIAL_BOOTSTRAP`;
3. fixture catalog creates entry raw records plus one manifest;
4. raw additive fields survive preservation;
5. normalization creates KEV canonical evidence;
6. ransomware `Unknown` survives unchanged;
7. date-only fields do not create source timestamps;
8. second changed snapshot becomes `SCHEDULED / LIVE_INCREMENTAL`;
9. unchanged entries do not create revisions;
10. changed entries do create immutable revisions;
11. new entries are inserted;
12. removed membership is visible from manifest history without a fabricated deletion event;
13. conditional `304` poll succeeds with zero new records;
14. checkpoint records the latest catalog metadata and retrieval channel;
15. lint/typecheck/unit tests/build/container build remain green.

## Out of scope

NODE-2B does not add:

- NVD enrichment;
- EPSS scoring;
- CVSS interpretation;
- AI summaries or severity;
- attack/victim counts;
- attribution;
- geography;
- risk scoring;
- measurements/history backfill;
- CİTEM Global View reads.

Those remain later NODE phases.

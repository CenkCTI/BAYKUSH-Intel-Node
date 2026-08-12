# Source Admission — abuse.ch ThreatFox

## Identity

- **BAYKUSH source key:** `THREATFOX`
- **Provider:** abuse.ch ThreatFox
- **Upstream origin key:** `ABUSE_CH_THREATFOX`
- **Source class:** `IOC_SHARING`
- **Observation basis:** `REPORTED`
- **Authority type:** `COMMUNITY_IOC_SHARING_PLATFORM`
- **Collection surface:** authenticated Community API `get_iocs`

## What this source represents

ThreatFox supplies source assertions that an indicator was reported to ThreatFox with source-defined IOC/threat classification and optional malware, confidence, tag, reporter, reference, first-seen, and last-seen metadata.

BAYKUSH preserves those source assertions as `IOC_REPORT` evidence.

## What this source does not represent

A ThreatFox IOC report is not equivalent to:

- an attack event;
- an incident or victim count;
- independent corroboration;
- proof that the IOC is malicious at the current moment;
- proof that an IP/domain is still reachable or controlled by the same actor;
- attacker identity or attacker country;
- campaign attribution;
- active exploitation of a vulnerability;
- asset exposure;
- business risk;
- remediation priority;
- BAYKUSH Global Priority;
- a global cyber threat level.

Absence from a recent query is not evidence that an indicator is benign and is not evidence that malicious activity did not occur.

## Upstream access and coverage limits

The Community API recent query filters by source `first_seen` and accepts only 1–7 days. NODE-2E therefore cannot claim complete historical ThreatFox coverage from this endpoint.

ThreatFox also expires IOCs older than six months from API/export surfaces. Previously collected BAYKUSH evidence is not deleted merely because it later disappears from the current upstream feed; disappearance is not interpreted as benignness or disproval.

NODE-2E v1 does not ingest ThreatFox bulk exports.

## Recovery semantics

BAYKUSH deliberately overlaps recent windows to tolerate outages. Gaps beyond seven days are explicitly marked `recoveryGapExceeded=true` because the Community API cannot reconstruct the missing interval through `get_iocs` alone.

No IOC ID, source array index, or `first_seen` timestamp is treated as an undocumented cursor.

## Time semantics

- source `first_seen` -> canonical `effective_at`;
- source `last_seen` -> source fact only;
- no source publication timestamp -> `published_at=null`;
- no record-update timestamp -> `upstream_updated_at=null`;
- BAYKUSH ingestion time remains `received_at`.

## Confidence semantics

`confidence_level` remains a ThreatFox source fact.

It is not mapped to analyst confidence, source reliability, business risk, priority, or corroboration strength.

## Indicator semantics

Canonical record identity is the ThreatFox report ID (`threatfox:ioc:<id>`), while the reported indicator is represented as an entity when safely normalizable.

This distinction intentionally keeps source reporting evidence separate from the underlying technical entity and enables future multi-source convergence without erasing provenance.

Unknown/new IOC types and malformed known indicator values remain available as source reports with explicit normalization status rather than being silently discarded.

## Malware semantics

ThreatFox malware labels are retained as source assertions and may be represented as `MALWARE` entities using the source Malpedia label.

This is not independent malware attribution by BAYKUSH.

## Geographic semantics

NODE-2E performs no GeoIP enrichment. If future phases geo-locate an IOC, that information must be modeled as observed infrastructure/geolocation context, never as attacker origin by default.

## Provenance and revisions

ThreatFox IOC `id` is the source record identity. A changed source object creates an immutable raw revision through the existing `(source, source_record_id, payload_sha256)` model. Exact repeat payloads deduplicate.

Query context is stored separately in a raw-only manifest so overlap-window changes do not manufacture IOC revisions.

## Fair use, commercial use, and redistribution

The Community API is documented by ThreatFox as free under fair-use principles, while commercial/for-profit use may require a paid enhanced abuse.ch commercial API subscription. NODE-2E therefore admits the source conservatively as:

- **license class:** `ABUSE_CH_FAIR_USE_2025_11_04`
- **commercial use:** `RESTRICTED`
- **redistribution:** `UNKNOWN`
- **enabled by default:** false

Before a commercial BAYKUSH deployment, the operator must re-review current abuse.ch terms and obtain any subscription/permission needed for the intended usage and redistribution model.

## Authentication boundary

The Community API requires an Auth-Key. BAYKUSH sends it only in the `Auth-Key` request header.

The secret must never be persisted in:

- source URLs;
- raw evidence;
- canonical evidence;
- query manifests;
- checkpoints;
- work descriptors;
- diagnostics;
- logs;
- repository files.

## Read-only admission

NODE-2E is retrieval-only. It does not submit, update, delete, comment on, or otherwise mutate ThreatFox content.

## Re-admission triggers

The source admission contract must be reviewed again if any of the following change materially:

- ThreatFox authentication mechanism;
- Community API recent-window semantics;
- response schema or source time fields;
- expiration policy;
- fair-use/commercial terms;
- redistribution terms;
- endpoint ownership/domain;
- BAYKUSH commercial deployment model;
- decision to ingest bulk exports or additional ThreatFox API methods.

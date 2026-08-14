# Source Admission — FEODO_TRACKER

## Decision

Status: `ADMITTED`

Policy: `feodo-tracker-admission-v1`

Terms reviewed: 2026-08-13

Next review: 2027-02-13

## Distinct analyst question

Which botnet command-and-control endpoints are published by Feodo Tracker in its non-aggressive IOC dataset?

## Publisher and origin

- provider: abuse.ch / Feodo Tracker
- source system: `FEODO_TRACKER`
- upstream origin: `FEODO_TRACKER`
- authority: public threat-feed provider

This source is treated as provider-reported IOC evidence, not a BAYKUSH sensor observation.

## Official access

BAYKUSH uses the official non-aggressive JSON IOC dataset documented on the Feodo Tracker blocklist page.

Collection contract:

- mode: `SNAPSHOT`
- default poll: 15 minutes
- provider minimum: 5 minutes
- authentication: none
- bounded record cap: 10,000 records/work unit
- bounded HTTP response: 16 MiB
- recovery: `SNAPSHOT_RECONSTRUCTION`
- historical retrieval: not claimed

The aggressive historical list is intentionally excluded because Feodo Tracker warns that recycled/reused IP addresses make that dataset prone to false positives.

## Record identity

One source record is identified deterministically from:

```text
IP
+ destination port
+ provider malware label
+ provider first_seen
```

Mutable fields such as status and last-online date do not change the source-record identity; a changed payload creates a new immutable source revision.

IP identity remains separate from destination port. Port is a fact, not part of the canonical IP entity key.

## Source time

- `first_seen`: provider UTC timestamp; mapped to `effective_at`
- `last_online`: provider date-only fact; retained as a date without fabricated midnight precision
- publication timestamp: not fabricated
- upstream update timestamp: not fabricated
- Node receipt time remains separate

## Canonical mapping

Record kind: `IOC_REPORT`

Primary canonical entities:

- `IP`
- source-scoped `MALWARE` label

Bounded facts include:

- IP
- port
- provider status
- hostname when present
- ASN number/name
- country code
- first-seen UTC instant
- last-online date
- provider malware label

## Semantic boundary

Represents:

> Botnet command-and-control IOC records published by Feodo Tracker in its non-aggressive dataset.

Does not represent:

- BAYKUSH sensor observation;
- attack count;
- victim count;
- infection count;
- bot population;
- organization compromise;
- attribution truth;
- global maliciousness or global threat level.

A successful empty snapshot is a valid source result. It must not be treated as provider failure. Conversely, provider/network/schema failure must not be converted into a numeric zero.

## Licensing and use

The Feodo Tracker blocklist page states that its datasets are available for commercial and non-commercial use without limitation under CC0.

NODE-5 policy:

- commercial use: `ALLOWED`
- redistribution: `ALLOWED`
- raw retention: `ALLOWED`
- canonical retention: `ALLOWED`
- derived data: `ALLOWED`
- public display: `ALLOWED`
- attribution: not required by CC0; BAYKUSH retains the source reference and does not imply abuse.ch endorsement

## Security

- fixed HTTPS hostname/path
- no credentials
- bounded response bytes
- strict record validation
- malformed identity/timestamp data fails closed as `SCHEMA_ERROR`
- no JavaScript/browser execution
- raw provider payload is not exposed through the Node read API

## Measurements

Source admission authorizes future derived measurements, but NODE-5B1 does not introduce activity-series semantics. Measurement definitions are added in the NODE-5H measurement/API phase so they remain centralized in the existing NODE-3 contract registry.

Potential future measurements must distinguish snapshot/current-list state from source-effective first-seen history and must never be labelled as attack volume.

## Acceptance requirements

- recorded fixture parsing
- deterministic source identity
- immutable revision behavior
- UTC first-seen parsing
- date-only last-online preservation
- successful empty snapshot behavior
- unchanged snapshot idempotency
- malformed record fail-closed behavior
- admission gate remains required before enablement
- existing five-source regression remains green

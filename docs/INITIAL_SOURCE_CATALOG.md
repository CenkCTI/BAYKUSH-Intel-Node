# Initial Source Catalog & Expansion Plan

## 1. Purpose

The Node is not evaluated by the number of feeds it ingests. A source is added only when it contributes a distinct, well-defined technical picture and satisfies the Source Adapter Contract.

This document is a roadmap, not an assertion that every listed source is already licensed/admitted. Current official access methods and terms are re-verified at admission time.

## 2. Wave N1 — Existing CİTEM production sources

NODE-2 first migrates the five sources already understood by CİTEM.

### CISA KEV

Role:

- exploited-vulnerability catalogue context.

Semantic intent:

- source class: `EXPLOITED_VULNERABILITY_CATALOG`;
- observation basis: `PUBLISHED`.

Planned measurements:

- catalogue additions;
- catalogue updates;
- vendor/product distributions where supported.

Guardrail:

- catalogue membership is not attack count, victim count, or organization-specific risk.

### NVD CVE

Role:

- vulnerability record/database activity.

Semantic intent:

- source class: `VULNERABILITY_DATABASE`;
- observation basis: `PUBLISHED`.

Planned measurements:

- CVE publications;
- CVE modifications;
- supported CVSS/CWE/vendor/product distributions.

### FIRST EPSS

Role:

- exploit-probability scoring context.

Semantic intent:

- source class: `EXPLOIT_PROBABILITY`;
- observation basis: `SCORED`.

Planned measurements:

- scored-record activity;
- score distributions/threshold populations only when the collected population is explicitly valid for that claim.

Guardrail:

- EPSS is not observed exploitation, CVSS severity, attack volume, analyst confidence, or business risk.

### ThreatFox

Role:

- public IOC reporting/sharing.

Semantic intent:

- source class: `IOC_SHARING`;
- observation basis: `REPORTED`.

Planned measurements:

- IOC reporting volume;
- distinct indicators;
- first-seen indicators;
- indicator-type composition;
- malware/tag composition where supported.

Guardrail:

- IOC reporting volume is not attack count.

### MalwareBazaar

Role:

- public malware sample repository/reporting.

Semantic intent:

- source class: `MALWARE_SAMPLE_REPOSITORY`;
- observation basis: `PUBLISHED` or the admission-verified equivalent.

Planned measurements:

- sample reporting volume;
- distinct hashes;
- first-seen hashes;
- malware/tag composition;
- file-type composition where supported.

Guardrail:

- repository sample volume is not infection prevalence.

## 3. Wave N2 — Measurement first

Before adding new sources, NODE-3 derives reliable historical measurements from N1.

This prevents source expansion from outrunning the product's ability to explain and visualize data.

## 4. Wave N3 — CİTEM Global View v1

NODE-4 integrates N1 measurements into CİTEM before broad source expansion.

Minimum domains:

- vulnerability & exploitation context;
- IOC reporting;
- malware reporting;
- source health/coverage.

## 5. Wave N4-A — Malware / IOC expansion

Priority candidates:

- URLhaus;
- SSLBL.

Potential value:

- malware-delivery URL reporting;
- malicious certificate/C2-related datasets;
- new domains/URLs/infrastructure dimensions.

Feodo Tracker remains optional/conditional and is admitted only if its current dataset provides useful active coverage under verified terms.

## 6. Wave N4-B — Vulnerability / advisory expansion

Priority candidates:

- GitHub Advisory Database;
- CISA ICS advisories.

Potential value:

- package ecosystem advisory activity;
- ICS/OT advisory activity;
- vendor/product/CVE distributions;
- critical-infrastructure technical context.

## 7. Wave N4-C — CERT / regional reporting

Priority candidates:

- CERT-EU;
- JPCERT/CC / JVN where appropriate official machine-readable/public feeds are verified.

Potential value:

- official/regional publication activity;
- CVE/vendor/product/report references;
- regional technical-reporting perspective.

Reporting volume remains publication/reporting activity, not regional attack volume.

## 8. Context knowledge

MITRE ATT&CK is planned as context knowledge, not live cyber-activity telemetry.

It may normalize referenced techniques/tactics and support report/entity context.

A count of ATT&CK technique references means ingested reporting referenced those techniques; it does not mean those techniques occurred globally that many times.

## 9. Wave N5 — Internet infrastructure telemetry

Priority target:

- RIPE RIS / suitable BGP telemetry through a dedicated streaming architecture.

Potential measurements:

- BGP announcements;
- BGP withdrawals;
- distinct prefixes;
- distinct ASNs;
- carefully defined routing-change metrics.

High-volume telemetry uses short raw retention and longer aggregate retention rather than persisting an unlimited firehose in the canonical intelligence tables.

## 10. Experimental/restricted sources

Sources with licensing or redistribution constraints may be supported in an explicitly restricted/research-only mode after policy review.

They must never silently enter the default commercial/public data path.

## 11. Later source families

After the core pipeline is stable:

- selected vendor PSIRTs;
- additional national CERT/CSIRT feeds;
- curated threat-research publishers;
- STIX/TAXII feeds;
- MISP/private feeds for private/enterprise Node deployments;
- approved DNS/certificate telemetry.

## 12. Source admission sequence

Each new source follows:

```text
research official access/terms
        -> source admission note
        -> adapter contract
        -> recorded fixtures
        -> raw ingestion
        -> normalization
        -> semantics
        -> recovery/coverage tests
        -> measurement definitions
        -> API/UI verification
        -> production enablement
```

No source bypasses this sequence simply because integration is easy.

## 13. Product principle

Each new source must answer:

> Which distinct technical question will an analyst be able to observe better because this source exists?

If the answer is only 'more records', the source is not yet justified.
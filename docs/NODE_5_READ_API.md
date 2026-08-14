# NODE-5 New-Source Read API

## Scope

This slice exposes the admitted NODE-5 source expansion through the existing authenticated, coverage-aware Node read API. It does not add CİTEM UI code and it does not introduce a new API architecture.

The existing measurement API is registry-driven. Therefore the NODE-5K measurement contracts become available through `/v1/techint/measurement-catalog` and the existing measurement/coverage endpoints without source-specific route code.

## Source inventory

`/v1/sources` and `/v1/sources/status` now include the original five production sources plus the admitted NODE-5 sources:

- CISA KEV
- NVD CVE
- FIRST EPSS
- ThreatFox
- MalwareBazaar
- Feodo Tracker
- SSLBL Certificate
- GitHub Advisory Database — Reviewed
- MITRE ATT&CK Enterprise
- JVN iPedia
- CISA ICS CSAF
- CERT-EU Security Advisories
- Siemens ProductCERT CSAF

`TEST_SYNTHETIC` remains internal and URLhaus remains absent because its admission review is blocked.

## Measurement exposure

The authenticated measurement catalog exposes the NODE-5K contracts for the four measurement-admitted new source roles:

- `ioc.feodo_tracker.new_records_observed`
- `ioc.sslbl.certificate_listings_observed`
- `vulnerability.github_advisory.publications`
- `vulnerability.github_advisory.updates_observed`
- `vulnerability.cisa_ics.advisory_publications`
- `vulnerability.cisa_ics.advisory_updates_observed`

MITRE ATT&CK, JVN, CERT-EU and Siemens remain visible as admitted source metadata/status sources but receive no measurement series in this revision because their admission policies set `measurementProjectionAllowed=false`.

## Semantic boundary

The API preserves the NODE-3 distinction between source-time measurement, Node-observation-time measurement, collection coverage and data availability. It does not translate advisory publication or IOC reporting into attack count, victim count, organization compromise, business risk or global threat level.

## Non-goals

- No CİTEM changes.
- No Global View v2 rendering.
- No new provider admission.
- No new public unauthenticated intelligence route.
- No merge in this stacked draft.

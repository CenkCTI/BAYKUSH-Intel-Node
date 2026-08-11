# NODE-0 Acceptance Criteria

NODE-0 is complete only when the architecture documents answer the following without requiring implementation-time product decisions.

## 1. System boundary

- The Node's responsibilities are explicit.
- CİTEM private workspace responsibilities are explicit.
- Future ANLAK projection is supported without forcing ANLAK data into a CİTEM-specific schema.
- Oracle is documented as an initial host, not an application dependency.

## 2. Source admission

For a proposed source, the documentation tells a developer/operator:

- what metadata must be declared;
- how source class/observation basis are assigned;
- how collection mode is selected;
- how recovery capability is described;
- how source identity and upstream origin differ;
- what licensing/terms data must be recorded;
- what questions must be answered before production enablement.

## 3. Raw truth and canonicalization

- Raw/source-native evidence is preserved according to policy.
- Duplicate delivery and upstream revision are distinguishable.
- Canonical evidence has a bounded V1 shape.
- Unknown optional fields are not fabricated.
- Every canonical output is traceable to raw/source provenance.

## 4. Time

- `received_at`, `published_at`, `effective_at`, and upstream update time are distinct where available.
- `INGESTION_TIME` and `SOURCE_EFFECTIVE_TIME` are explicit analytical axes.
- Bootstrap ingestion cannot automatically become a current-activity spike.

## 5. Recovery

- The system can represent historical query, cursor catch-up, snapshot reconstruction, and live-only sources.
- Restart/recovery prioritizes regaining the present without abandoning historical catch-up.
- Unrecoverable downtime remains an explicit gap.

## 6. Coverage

- `COMPLETE`, `PARTIAL`, `DEGRADED`, and `NO_COVERAGE` are defined.
- Data availability and live collection coverage are separate.
- Valid zero has an explicit eligibility rule.
- Missing coverage can never silently become zero activity.

## 7. Semantics

- `OBSERVED`, `REPORTED`, `PUBLISHED`, `SCORED`, `ENRICHED`, and `UNKNOWN` are defined.
- Source classes are controlled.
- `represents` / `does_not_represent` boundaries are required.
- Statistical/derived output cannot upgrade a source's epistemic basis.

## 8. Measurements

- Measurements are versioned contracts rather than arbitrary UI queries.
- Measurement points can be unavailable/null.
- Coverage metadata accompanies measurements.
- Initial measurements for the first five sources are identified.
- Distribution, distinct, and first-seen concepts are defined.
- Current-versus-previous comparisons require adequate coverage.
- Anomaly analysis is optional context, not a prerequisite for useful measurements.

## 9. API

- CİTEM consumes a versioned API rather than direct Node database access.
- Initial endpoint families are defined.
- API queries are bounded/paginated.
- Numeric unknown is not serialized as zero.
- Semantics and freshness can be exposed to clients.
- Source/database credentials are never returned.

## 10. Security

- Global/public Node data and private analyst data are separated.
- Upstream payloads are treated as untrusted.
- Source credentials are server-side only.
- Database is not intended for public direct access.
- Generic user-controlled fetch/SSRF behavior is explicitly deferred until safely designed.
- Raw-content retention does not imply redistribution permission.

## 11. Lineage and licensing

- Source-system and upstream-origin identities are distinct.
- Mirrors cannot automatically create independent corroboration.
- Unknown license/redistribution status is not treated as permission.
- Admission-time official terms verification is required.

## 12. Source roadmap

- The first implementation sources are CISA KEV, NVD, FIRST EPSS, ThreatFox, and MalwareBazaar.
- New-source expansion happens only after measurements and CİTEM Global View v1 prove the end-to-end value.
- Internet streaming telemetry is deferred to a dedicated phase.

## 13. Implementation readiness

NODE-1 may begin when all previous criteria are satisfied and no unresolved question would force NODE-1 to decide a new product-level semantic boundary on its own.

NODE-1 is allowed to choose implementation details such as exact TypeScript interfaces, SQL names, libraries, test harness layout, and runtime process packaging as long as they comply with NODE-0 contracts.

## 14. NODE-0 non-goals

The NODE-0 PR must contain no production source credentials, no live Oracle configuration, no production collector implementation, no CİTEM database changes, and no ANLAK implementation.
# Source Semantics

## 1. Purpose

Normalization must never erase what kind of epistemic claim a source actually makes. The Node therefore carries explicit semantics from source admission through canonical records, measurements, and API responses.

## 2. Observation basis

Controlled initial values:

- `OBSERVED` — direct technical observation by the source according to its declared capability;
- `REPORTED` — the source reports or shares a claim/record about activity;
- `PUBLISHED` — the source publishes a catalogue, advisory, record, or document;
- `SCORED` — the source provides a score/probabilistic estimate;
- `ENRICHED` — the source adds derived metadata/context to another subject;
- `UNKNOWN` — the basis cannot be safely classified.

## 3. Source classes

Initial controlled source classes include:

- `VULNERABILITY_DATABASE`;
- `EXPLOITED_VULNERABILITY_CATALOG`;
- `EXPLOIT_PROBABILITY`;
- `IOC_SHARING`;
- `MALWARE_SAMPLE_REPOSITORY`;
- `OFFICIAL_ADVISORY`;
- `CERT_CSIRT_REPORTING`;
- `THREAT_RESEARCH`;
- `CAMPAIGN_REPORTING`;
- `INFRASTRUCTURE_TELEMETRY`;
- `DNS_OBSERVATION`;
- `CERTIFICATE_OBSERVATION`;
- `ROUTING_TELEMETRY`;
- `CONTEXT_KNOWLEDGE`;
- `UNKNOWN`.

## 4. Authority type

Authority describes publisher role, not universal truth quality. Initial examples:

- government;
- CERT/CSIRT;
- standards/knowledge-base publisher;
- vulnerability authority/database;
- vendor;
- security research organization;
- community sharing platform;
- telemetry operator;
- unknown.

## 5. Semantic boundary

Each source/record kind must expose two human-readable statements:

- `represents` — what the data legitimately describes;
- `does_not_represent` — common overinterpretations explicitly rejected.

Examples:

### ThreatFox IOC reporting

Represents: IOC records reported through the ThreatFox source.

Does not represent: cyberattack count, victim count, infection count, or global malicious activity.

### MalwareBazaar sample reporting

Represents: malware sample records published/available through MalwareBazaar.

Does not represent: infections, compromised hosts, campaign size, or prevalence in the global population.

### FIRST EPSS

Represents: a forward-looking exploitation probability score under the source methodology.

Does not represent: observed exploitation, CVSS severity, attack count, analyst confidence, or organizational risk.

### CISA KEV

Represents: vulnerabilities included in CISA's Known Exploited Vulnerabilities catalog under its published inclusion process.

Does not represent: exploit count, victim count, universal exploitation prevalence, or organization-specific risk.

## 6. Semantic inheritance

Derived measurements inherit their source semantic boundary.

A statistical change in a `REPORTED` series remains a change in reporting, not an upgrade to direct observation.

An anomaly/deviation marker does not change semantic basis.

## 7. Multi-source semantics

When different source classes reference the same subject, the Node must preserve each claim separately before producing any convergence view.

Example:

```text
CVE X
- NVD: PUBLISHED vulnerability record
- CISA KEV: PUBLISHED known-exploited catalogue membership
- EPSS: SCORED exploitation probability
- threat report: REPORTED campaign reference
```

These are complementary facts, not interchangeable confirmations of one claim.

## 8. Versioning

Semantic mappings are versioned. A changed classification or interpretation requires a new semantic-contract version and deterministic recomputation where appropriate.

Historical records must retain the version used to derive them.

## 9. UI/API vocabulary

The Node's metadata should enable CİTEM to prefer precise labels such as:

- IOC reporting volume;
- malware sample reporting;
- KEV catalogue additions;
- CVE publications/updates;
- advisory publication activity;
- BGP withdrawal activity;

and avoid unsupported labels such as:

- attack activity;
- infection volume;
- attacker origin;
- global threat level;
- confirmed campaign size.

## 10. AI boundary

AI cannot change observation basis, source class, authority type, or semantic boundary in canonical state. Any AI interpretation must remain explicitly derivative and separate.
# NODE-5 Source Expansion Acceptance

## Scope

This document closes the **source-admission and source-adapter expansion** portion of NODE-5. It does not close NODE-5 as a whole. Measurement/API extensions and CİTEM Global View v2 remain separate downstream phases.

## Admitted production sources

| Source key | Role | Canonical projection | Measurement projection | Default state |
|---|---|---:|---:|---|
| `FEODO_TRACKER` | Provider-reported botnet C2 IOC metadata | Yes | Yes | Disabled |
| `SSLBL_CERTIFICATE` | Provider-reported malicious certificate fingerprints | Yes | Yes | Disabled |
| `GITHUB_ADVISORY_REVIEWED` | Reviewed package security advisories | Yes | Yes | Disabled |
| `MITRE_ATTACK_ENTERPRISE` | ATT&CK Enterprise context knowledge | Yes | No | Disabled |
| `JVN_IPEDIA` | Recent JVN iPedia vulnerability-advisory surface | Yes | No | Disabled |
| `CISA_ICS_CSAF` | CISA-distributed OT CSAF advisories | Yes | Yes, advisory-publication semantics only | Disabled |
| `CERT_EU_SECURITY_ADVISORY` | Recent CERT-EU advisory publications | Yes | No | Disabled |
| `SIEMENS_PRODUCTCERT_CSAF` | Siemens ProductCERT TLP:WHITE vendor advisory publications | Yes | No | Disabled |

## Researched but not admitted

### URLhaus

URLhaus remains outside the runtime registry in this revision. The current official Community API dataset-download model embeds the Auth-Key in the request URL path. That does not yet satisfy the Node secret-handling boundary for safe URLs, provenance, checkpoints, errors and operator output.

The source may be reconsidered after credential transport, fair-use/commercial entitlement, retention and redistribution constraints are explicitly resolved.

## Invariants

The source-expansion acceptance test enforces:

1. every admitted NODE-5 source has a runtime adapter;
2. every admitted NODE-5 source has a code-level admission policy;
3. every newly admitted source remains disabled by default;
4. measurement projection is allowed only for explicitly admitted source roles;
5. URLhaus remains unregistered while its admission is blocked;
6. runtime source keys remain unique.

## Semantic boundary

Source expansion does not authorize analysis claims. In particular:

- IOC/report counts are not attack counts;
- advisory publication counts are not exploitation counts;
- ATT&CK technique publication is not technique prevalence;
- vendor/CERT publication is not proof of customer exposure;
- a source revision is not automatically a threat-level change;
- recent-feed coverage must not be represented as complete historical coverage.

## Next NODE-5 phases

Source expansion feeds the remaining NODE-5 work in this order:

1. measurement contracts/projectors for only the measurement-admitted new sources;
2. coverage-aware read API exposure for those measurements;
3. CİTEM TechINT Global View v2 integration;
4. final NODE-5 acceptance, documentation and operator validation.

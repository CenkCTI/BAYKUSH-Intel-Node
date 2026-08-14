# Source Admission — SIEMENS_PRODUCTCERT_CSAF

## Decision

Status: `ADMITTED`

Policy: `siemens-productcert-rolie-admission-v1`

Terms reviewed: 2026-08-14 (Europe/Warsaw)

Next review: 2027-02-14

## Analyst question

Which TLP:WHITE security-advisory publications are exposed by the Siemens ProductCERT trusted-provider CSAF ROLIE feed?

## Official access

Siemens ProductCERT publishes CSAF provider metadata declaring a trusted-provider role and a TLP:WHITE ROLIE feed. NODE-5I consumes only that machine-readable publication feed.

The first source revision intentionally does **not** download and flatten the full CSAF advisory body. It retains publication metadata and document provenance from the ROLIE entry: stable advisory identity, title, publication/update timestamps, document URL/type and the standard ROLIE hash link when present.

## Canonical mapping

Record kind: `SECURITY_ADVISORY`

Canonical identity: Siemens `SSA-YY-NNN` advisory identity when present in the ROLIE entry. A deterministic source-scoped fallback is used only if the publication surface lacks an SSA identifier.

CVE identifiers present in the ROLIE entry metadata become canonical `CVE` entities. The source does not invent product, severity, exploitation, remediation or affected-version facts that are only available inside the full CSAF document.

## Time model

- ROLIE `published` → source published/effective time;
- ROLIE `updated` → upstream updated time;
- Node receipt time remains independent;
- feed-level `updated` belongs to the manifest, not to every advisory.

## Semantic boundary

Represents TLP:WHITE vendor security-advisory publications exposed by Siemens ProductCERT's trusted-provider CSAF ROLIE feed.

Does not represent deployment prevalence, exploitation confirmation, attack count, victim count, customer exposure, business risk, remediation priority, attribution truth or global threat level.

Because this first revision is a publication snapshot rather than an admitted complete historical coverage model, `measurementProjectionAllowed=false`.

## Use constraints

The source policy records commercial use, redistribution, retention, derived use and public display as allowed subject to Siemens ProductCERT terms: preserve the original advisory link, identify modifications, retain applicable notices and do not use Siemens marks or advisory material misleadingly.

## Security and resilience

- fixed HTTPS host/path;
- bounded JSON response size and entry count;
- strict ROLIE publication schema;
- deterministic snapshot fingerprinting;
- unchanged snapshot idempotency;
- no credentials;
- disabled by default;
- admission gate required before enablement;
- no browser execution or active interaction with customer infrastructure.

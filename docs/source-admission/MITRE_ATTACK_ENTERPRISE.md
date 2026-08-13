# Source Admission — MITRE_ATTACK_ENTERPRISE

## Decision

Status: `ADMITTED`

Policy: `mitre-attack-enterprise-admission-v1`

Terms reviewed: 2026-08-14 (Europe/Warsaw)

Next review: 2027-02-14

## Analyst question

What Enterprise techniques and sub-techniques are currently published in the official MITRE ATT&CK knowledge base?

## Source role

This is a **context knowledge** source. It supplies a controlled vocabulary and published technique metadata for downstream entity linking and analyst context. It is not an activity sensor or an evidence source for technique prevalence.

## Official access

The adapter consumes the official Enterprise ATT&CK STIX JSON representation published by MITRE's ATT&CK data repository. Collection is a bounded daily snapshot with deterministic snapshot fingerprinting and no authentication.

## Canonical mapping

Record kind: `CONTEXT_KNOWLEDGE`

Entity kind: `ATTACK_TECHNIQUE`

Preserved source facts include STIX identity, ATT&CK external ID, name, description, created/modified timestamps, ATT&CK version, revoked/deprecated state, sub-technique flag, platforms, and tactic phases.

## Semantic boundary

Represents published ATT&CK Enterprise technique knowledge.

Does not represent observed technique use, event frequency, campaign confirmation, actor attribution, organization compromise, or threat-level measurement.

`measurementProjectionAllowed=false` is intentional. A technique appearing or changing in ATT&CK is a knowledge-base publication event, not evidence that adversary activity increased.

## Licensing and branding

MITRE permits ATT&CK use for research, development, and commercial purposes. Copies must preserve MITRE's copyright designation and license. BAYKUSH must not imply MITRE affiliation, sponsorship, or endorsement.

NODE-5 policy therefore records commercial use as allowed while redistribution/public display remain conditional on the required notices.

## Security and operations

- fixed HTTPS host/path
- bounded response size and timeout
- strict STIX attack-pattern validation
- unchanged snapshot idempotency
- disabled by default
- no provider credentials
- no active scanning or interaction with external infrastructure

## Deferred scope

ATT&CK relationships, group/software mapping, convergence, cross-source corroboration, and analyst inference are intentionally deferred to later graph/convergence phases rather than being synthesized in this source adapter.

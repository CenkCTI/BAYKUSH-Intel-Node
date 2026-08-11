# Security Boundary

## 1. Default trust model

The BAYKUSH Intelligence Node is a service that retrieves untrusted Internet content and exposes curated global/public intelligence to trusted BAYKUSH clients.

Every upstream payload is untrusted input.

## 2. Public/global versus private analyst data

Default Node deployments store global/public or explicitly approved source data only.

CİTEM private workspace data must not be automatically synchronized into the Node, including:

- investigations;
- private evidence;
- uploads;
- analyst notes;
- private indicators;
- attribution hypotheses;
- organization-internal telemetry;
- private reports;
- BYOK credentials.

A future private/enterprise Node is a separate deployment/security mode.

## 3. Credential isolation

Source provider credentials:

- exist only server-side;
- are not embedded in client bundles;
- are not stored in raw/canonical intelligence records;
- are not returned by APIs;
- are redacted from logs/errors;
- use least privilege where the provider supports it.

Database credentials follow the same server-only rule.

## 4. Network exposure

Early production-like deployment should expose only required ingress, normally HTTPS API and tightly restricted administration.

PostgreSQL must not be generally exposed to the public Internet.

Workers/schedulers do not require public inbound ports.

## 5. Upstream fetching

Adapters use fixed/admitted upstream endpoints and controlled redirects.

Arbitrary user-supplied URL fetching is outside NODE-1 scope.

When generic feeds are later introduced, the design must include SSRF protections, DNS/IP validation, redirect controls, response-size caps, content-type validation, and network egress policy.

## 6. Untrusted payload controls

Every adapter must apply:

- schema validation;
- payload-size bounds;
- record-count bounds;
- timeout/abort controls;
- safe parsing;
- controlled decompression limits;
- no execution of source-provided code/content;
- safe logging/redaction.

HTML/XML parsing must not enable unsafe external entity/resource resolution.

## 7. API controls

Before Internet-exposed use:

- authentication for BAYKUSH clients;
- authorization appropriate to endpoint class;
- request rate limiting;
- maximum query ranges/page sizes;
- strict parameter validation;
- bounded response sizes;
- CORS policy;
- secure headers/TLS termination;
- stable non-sensitive error responses.

## 8. Database integrity

Canonical/raw/derived identities should enforce uniqueness and ownership/global-scope constraints at the database boundary where practical.

Workers should use narrowly scoped database roles rather than one unrestricted superuser credential for all runtime paths.

Schema migration capability must remain separate from normal read API permissions.

## 9. Raw-content exposure

Raw source payload storage does not imply raw payloads are safe or legally permitted for public API redistribution.

Provenance endpoints should expose only the allowed representation under source policy and security controls.

## 10. Logging

Operational logs must avoid:

- API keys;
- authorization headers;
- database URLs/passwords;
- full sensitive upstream error bodies;
- unnecessary raw payload dumps.

Logs should include correlation IDs, source/work-unit identity, safe error class, and timing sufficient for diagnosis.

## 11. Supply chain

NODE-1 CI should include lockfile-based deterministic dependency installation and basic dependency/security review. Runtime images should be minimal and run as non-root where practical.

## 12. Availability and abuse

The API is not a bulk public data-dump service by default. Hard bounds protect the small initial infrastructure from abusive or accidental expensive queries.

Collector rate limits respect upstream provider policy independently of client demand.

## 13. Backup boundary

If PostgreSQL initially runs on the same Oracle VM, the deployment is a single failure domain. Production-like use therefore requires off-host encrypted backup of critical database state.

Secrets must not be included in plaintext backups or repository files.

## 14. AI boundary

AI is not permitted to bypass source admission, fetch arbitrary unapproved resources, modify canonical provenance, or alter source semantic classifications.

## 15. Security acceptance invariant

Compromise or misuse of a CİTEM client must not automatically reveal upstream provider credentials or unrestricted Node database access.
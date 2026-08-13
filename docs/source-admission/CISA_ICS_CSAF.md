# Source Admission — CISA_ICS_CSAF

## Decision

Status: `ADMITTED`

Policy: `cisa-ics-csaf-admission-v1`

Terms reviewed: 2026-08-14 (Europe/Warsaw)

Next review: 2026-11-14

## Analyst question

Which Operational Technology security advisories are distributed through CISA's official CSAF repository?

## Official access

CISA maintains an official public repository of CSAF 2.0 security advisories for Information Technology and Operational Technology. NODE-5E admits only the `csaf_files/OT/white` advisory surface.

Collection first resolves the current repository branch to an immutable Git commit and OT/white tree SHA. All advisory documents in that collection run are then read from the pinned commit, preventing a branch update from creating a mixed snapshot mid-run.

The adapter ignores detached signature and checksum files and admits only bounded advisory JSON paths. New or changed blobs are paged in bounded work units; unchanged trees produce no duplicate advisory revisions.

## Canonical mapping

Record kind: `SECURITY_ADVISORY`

Canonical identity: CSAF `document.tracking.id`.

Preserved facts include title and publisher, CSAF tracking status/version, initial and current release dates, CVE/CWE identifiers, CISA critical-infrastructure-sector notes when present, and immutable repository path/source commit provenance.

CVE identifiers become canonical `CVE` entities. Product-tree structure stays in raw evidence for later product-aware projection rather than being flattened into unsupported product identities in this source slice.

## Time model

- `initial_release_date` → source published/effective time;
- `current_release_date` → upstream updated time;
- Node receipt time remains independent;
- repository commit/tree identity is provenance, not a fabricated advisory timestamp.

## Republication boundary

CISA documents that its CSAF repository includes both CISA-produced advisories and republications from vendor partners, with original vendor dates/revision history retained. BAYKUSH therefore treats this as a mixed-publisher distribution surface rather than assuming every advisory has identical downstream-use terms.

Policy is intentionally conservative:

- commercial use: `RESTRICTED`;
- redistribution: `RESTRICTED`;
- raw retention: `ALLOWED`;
- canonical retention: `ALLOWED`;
- derived/public display: `RESTRICTED` pending source-specific notices;
- CISA/original-publisher references remain traversable;
- no endorsement may be implied.

## Semantic boundary

Represents OT security advisories distributed through CISA's official machine-readable CSAF repository.

Does not represent exploitation confirmation, attack count, victim count, organization exposure, remediation priority, business risk, attribution truth, or global threat level.

`measurementProjectionAllowed=true` permits later measurement of **advisory publication/revision activity only**. It does not authorize relabelling advisory counts as cyberattack activity.

## Security and resilience

- fixed GitHub API and raw-content hosts/paths;
- immutable source commit pinning;
- bounded tree/advisory response sizes;
- strict CSAF 2.0 tracking schema;
- bounded changed-entry set and bounded page size;
- restart-safe active-work checkpoint;
- no credentials;
- disabled by default;
- no browser execution or active interaction with external infrastructure.

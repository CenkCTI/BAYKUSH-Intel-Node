# Source Admission Review — URLHAUS

## Decision

Status: `RESEARCHED — NOT ADMITTED`

Reviewed: 2026-08-14 (Europe/Warsaw)

Re-review trigger: a provider-supported credential transport that does not require embedding the secret in the dataset URL, or an approved Node transport design that can preserve the existing secret-handling boundary without leaking the credential into logs, provenance, checkpoints, errors, or source references.

## Analyst value

URLhaus is a high-value community source for malware-distribution URLs. Its data could add URL-centric IOC evidence distinct from the currently admitted Feodo Tracker, SSLBL, ThreatFox and MalwareBazaar source roles.

That value alone is not sufficient for admission. NODE-5 requires the collection, retention, licensing and credential-handling contract to be acceptable before a source can be enabled.

## Current official access model

The current URLhaus Community API documentation requires an `Auth-Key` for dataset/file downloads. The documented download pattern places that key inside the URL path for the export request.

URLhaus also documents that community API use is subject to fair-use principles and that commercial/for-profit use may require the enhanced commercial API.

The database dumps are refreshed frequently and include bounded recent/current URL populations, but the credential transport is the blocking issue for this admission revision.

## Why collection is not admitted yet

The BAYKUSH Intelligence Node source transport is designed around these secret-handling constraints:

- credentials remain server-side;
- credentials are not part of canonical source references;
- credentials are not persisted in checkpoints, raw provenance or error messages;
- credentials must not be exposed through operator status/read APIs;
- source URLs should remain safe to log or inspect without revealing a secret.

Using the documented URLhaus export URL literally would place the Auth-Key in the request URL path. Even if the application attempted to redact logs, this creates a larger secret-bearing surface than the currently admitted source contracts.

NODE-5 therefore fails closed: no production URLhaus adapter is registered and no runtime enable path is added in this review.

## Old unauthenticated download paths

Legacy/public download paths must not be treated as a substitute merely because an endpoint still responds. Admission follows the provider's current documented API contract, not an undocumented or potentially stale compatibility surface.

## Licensing and commercial boundary

The Community API is documented as free under fair-use principles, while commercial/for-profit use may require the enhanced commercial API. Until BAYKUSH has a source-specific commercial entitlement decision, commercial-use status should be treated as restricted rather than assumed free.

## Required conditions for a future admitted revision

A later revision may move URLhaus to `ADMITTED` only after all of the following are satisfied:

1. credential transport is explicitly approved and cannot leak the Auth-Key into logs, errors, provenance, checkpoints, source references, metrics or API responses;
2. download cadence respects the provider's documented minimum intervals;
3. the selected dataset has a bounded semantic contract and a restart-safe snapshot/recovery model;
4. commercial/fair-use status is explicitly compatible with the deployment context;
5. raw/canonical retention and redistribution/public-display rules are recorded;
6. deterministic recorded-fixture tests cover identity, source time, duplicates, snapshot changes, empty results and failure handling;
7. the source remains disabled by default and passes the NODE-5 admission gate before any enablement.

## Semantic boundary for future work

If admitted later, URLhaus data would represent provider-shared malware-distribution URL records. Counts must not be relabelled as attack count, victim count, infection count, compromise count, attribution truth or global threat level.

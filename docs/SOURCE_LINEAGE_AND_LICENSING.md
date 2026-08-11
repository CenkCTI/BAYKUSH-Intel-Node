# Source Lineage & Licensing

## 1. Purpose

The Node must know both where intelligence came from and whether BAYKUSH is permitted to collect, retain, transform, expose, or redistribute it.

A source is not production-ready until origin and usage terms are understood.

## 2. Source-system versus upstream-origin identity

`source_key` identifies the technical feed/adapter consumed by the Node.

`upstream_origin_key` identifies the independent upstream origin of the underlying information when known.

Example:

```text
Source system A -> upstream NVD
Source system B -> upstream NVD
```

A convergence view may report two source systems but must not treat them as two independent origins.

## 3. Lineage relationships

Controlled lineage relationships should support at least:

- `ORIGINAL`;
- `MIRROR_OF`;
- `DERIVED_FROM`;
- `AGGREGATES`;
- `REPUBLISHES`;
- `UNKNOWN`.

Lineage must be source-supported/documented or conservatively classified as unknown.

## 4. Why lineage matters

Lineage protects against false corroboration.

The Node must distinguish:

```text
4 source systems
3 upstream origins
```

from:

```text
4 independent confirmations
```

unless independence is actually established.

## 5. Licensing metadata

Each source definition records at least:

- `license_class`;
- `terms_reference`;
- `terms_checked_at`;
- `attribution_required`;
- `commercial_use_status`;
- `redistribution_status`;
- `raw_retention_status`;
- `derived_data_status` when distinguishable;
- operator notes/constraints.

Statuses should use conservative controlled values such as:

- `ALLOWED`;
- `RESTRICTED`;
- `NON_COMMERCIAL_ONLY`;
- `REQUIRES_PERMISSION`;
- `UNKNOWN`.

## 6. Unknown terms

`UNKNOWN` is not permission.

If commercial or redistribution status is unknown, the source must not silently become part of a commercial/public redistribution path.

The Node may support research-only/disabled adapters whose data is isolated according to policy.

## 7. Data classes

Licensing decisions may differ by data class:

- raw payload;
- normalized canonical facts;
- derived measurements;
- metadata/reference links;
- public display;
- downstream redistribution/API access.

The contract must not assume permission to collect implies permission to redistribute raw source content.

## 8. Terms changes

Source terms can change. Source admission therefore stores `terms_checked_at` and requires periodic operational review before commercial/public production reliance.

A material licensing change may:

- disable collection;
- disable public exposure while retaining permitted internal derived state;
- require reprocessing/deletion according to applicable terms;
- require a new source policy version.

## 9. Attribution

Where attribution is required, API/UI metadata must preserve enough information for downstream BAYKUSH modules to render required attribution.

Attribution requirements must not be stripped during normalization.

## 10. Initial source policy

NODE-2 migrates existing sources only after current terms are re-verified during adapter admission.

NODE-5 source expansion requires a source-specific admission note recording current official access method and terms.

No licensing assumption in a roadmap table is a substitute for admission-time verification.

## 11. Security relationship

Credentials used to access a source are operational secrets, not lineage metadata. They are stored separately from source definitions and are never exposed to clients.

## 12. Acceptance invariant

For every production source, the operator must be able to answer:

> Who is the upstream origin, what is our relationship to this feed, and what are we allowed to do with the data?
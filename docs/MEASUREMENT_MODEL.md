# Technical Measurement Model

## 1. Purpose

CİTEM Global View should consume controlled, chart-ready measurements rather than issue arbitrary raw-record queries. The Node therefore defines measurements as versioned semantic contracts.

The primary question is:

> What measurable technical activity did approved sources expose over time, with what coverage and semantic limits?

## 2. Measurement definition

Each measurement definition must include:

- immutable `measurement_key`;
- domain;
- display label;
- unit;
- aggregation method;
- supported time axis;
- source scope;
- source/record semantic requirements;
- coverage policy;
- `represents`;
- `does_not_represent`;
- calculation version;
- supported dimensions/distributions;
- supported granularities.

## 3. Initial domains

- `VULNERABILITY`;
- `EXPLOITATION_CONTEXT`;
- `IOC_REPORTING`;
- `MALWARE_REPORTING`;
- `OFFICIAL_REPORTING`;
- `INTERNET_INFRASTRUCTURE` (later);
- `SOURCE_HEALTH` (operational, not cyber activity).

## 4. Measurement points

A chart-ready point should conceptually expose:

```text
measurement_key
bucket_start
bucket_end
granularity
time_axis
value

source_key?
source_scope
coverage_status
data_availability
acquisition_basis

calculation_version
input_fingerprint
calculated_at
```

`value` may be null/unavailable. Null must never be coerced to numeric zero.

## 5. Initial granularities

The history layer should support:

- `FIVE_MINUTES` where source cadence warrants it;
- `HOUR`;
- `DAY`.

API resolution may select a coarser stored granularity for large time windows.

## 6. Time ranges

CİTEM Global View should eventually support at least:

- 1 hour;
- 6 hours;
- 24 hours;
- 7 days;
- 30 days;
- later 90 days and 1 year.

The API must bound returned points per series rather than send unbounded history to clients.

## 7. Initial measurement catalogue

### CISA KEV

- `vulnerability.cisa_kev.additions`;
- `vulnerability.cisa_kev.updates`;
- distributions by vendor/product where source-supported.

### NVD

- `vulnerability.nvd.publications`;
- `vulnerability.nvd.modifications`;
- distributions by supported CVSS/CWE/vendor/product fields.

### FIRST EPSS

- `exploitation.epss.scored_records`;
- score-distribution measurements only when collection coverage makes the represented population explicit.

A bounded top-result pull must not be labelled a global EPSS distribution.

### ThreatFox

- `ioc.threatfox.reporting_volume`;
- `ioc.threatfox.distinct_indicators`;
- `ioc.threatfox.first_seen_indicators`;
- IOC-type distribution;
- malware/tag distribution where source-supported.

### MalwareBazaar

- `malware.malwarebazaar.sample_reporting`;
- `malware.malwarebazaar.distinct_hashes`;
- `malware.malwarebazaar.first_seen_hashes`;
- malware/tag distribution;
- file-type distribution where source-supported.

## 8. Distribution measurements

Total volume is insufficient for analyst discovery. The Node should support bounded distributions such as:

```text
bucket
measurement_key
dimension
dimension_value
count
share
coverage_status
calculation_version
```

Examples:

- IOC type;
- malware family/tag;
- package ecosystem;
- vendor/product;
- CWE;
- ASN/TLD later.

## 9. Entity novelty

Where deterministic entity identity exists, measurements may distinguish:

- observations;
- distinct entities;
- first-seen entities;
- previously known entities.

`first_seen` means first seen by the Node/global dataset under the relevant canonical identity, not first existence in the world unless the source explicitly establishes that fact.

## 10. Period comparison

Current-versus-previous period comparison is derived only if both windows meet the measurement's coverage policy.

If one window lacks sufficient coverage:

```text
current: known value
previous comparison: unavailable
reason: insufficient coverage
```

The Node must not calculate a misleading percentage against unknown data.

## 11. Bootstrap behavior

Bootstrap records use source-effective timestamps for historical charts when legitimate.

Their ingestion volume may be available in collection diagnostics but must not appear as a false present-day cyber-activity spike.

## 12. Anomaly relationship

Measurements are primary product data.

Baseline/anomaly analysis is optional derived context layered above measurements. A measurement remains useful when anomaly analysis is absent, disabled, or still learning history.

## 13. Provenance

Every measurement must be traceable through:

```text
measurement point
  -> eligible canonical/raw inputs
  -> source records
  -> source definition/semantics
```

Derived inputs are fingerprinted so late records or repaired coverage deterministically recompute the same bucket identity.

## 14. Acceptance invariant

A chart must communicate technical movement without implying more than the source data establishes.
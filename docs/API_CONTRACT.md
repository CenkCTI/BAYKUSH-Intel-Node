# Node API Contract

## 1. Purpose

CİTEM and future BAYKUSH modules consume the Node through a versioned service contract, not direct database access.

The API is designed for bounded global-intelligence reads and operational health. It does not expose unrestricted SQL-like querying.

## 2. Versioning

Initial base path:

```text
/v1
```

Breaking response/semantic changes require a new API version or explicitly versioned field/contract.

Measurement, semantic, and canonical model versions remain visible in responses when relevant.

## 3. Authentication boundary

NODE-0 does not prescribe the final authentication implementation, but the API must support authenticated BAYKUSH clients before Internet-exposed production use.

No source provider credential is ever returned to CİTEM.

No database credential is exposed to clients.

## 4. Initial endpoints

### Health

`GET /v1/health`

Returns bounded service health suitable for deployment checks.

May include:

- API status;
- database reachability status;
- worker/scheduler heartbeat summary;
- server time;
- service version.

Must not leak secrets or provider credentials.

### Sources

`GET /v1/sources`

Returns admitted source definitions safe for clients, including semantic and licensing-display metadata.

`GET /v1/sources/status`

Returns operational source status such as freshness, last successful collection, current health class, and latest coverage summary.

Source health is explicitly operational and not a cyber-threat score.

### TechINT summary

`GET /v1/techint/summary`

Parameters may include:

- `from` / `to` or controlled range;
- domains;
- source filters.

Returns a bounded current technical picture assembled from controlled measurements and source status.

### Measurements

`GET /v1/techint/measurements`

Parameters:

- controlled `measurement_key` list;
- `from`;
- `to`;
- optional requested resolution;
- optional supported source/dimension filters.

Response includes:

- measurement metadata;
- chart-ready points;
- coverage metadata;
- source-effective/ingestion time basis;
- calculation version;
- optional anomaly/deviation overlays when later supported.

### Distributions

`GET /v1/techint/distributions`

Returns bounded dimension distributions for approved measurement/dimension pairs.

### Changes

`GET /v1/techint/changes`

Returns deterministic factual change events such as:

- new canonical record;
- updated source record;
- new entity in Node history;
- measurement movement;
- composition movement;
- source-status change.

This endpoint does not emit strategic conclusions.

### Entity lookup

`GET /v1/techint/entities/{canonical-key-or-id}`

Returns global/public canonical entity context, source references, first/last seen history, and bounded related records.

### Records

`GET /v1/techint/records`

Bounded search/filter over approved canonical record fields.

Arbitrary full-table access is forbidden.

### Provenance

`GET /v1/techint/provenance/{id}`

Returns the trace chain from a canonical/derived record back to source evidence that is permitted to be exposed.

### Coverage

`GET /v1/techint/coverage`

Returns collection/data-availability coverage for requested sources/measurements/time ranges.

## 5. Response envelope

Responses should converge on a predictable envelope, for example:

```json
{
  "apiVersion": "v1",
  "generatedAt": "...",
  "data": {},
  "meta": {
    "nextCursor": null,
    "limits": {},
    "versions": {}
  }
}
```

Exact TypeScript/Zod schemas are defined in NODE-1/NODE-4.

## 6. Pagination

Record/entity/change endpoints use cursor-based bounded pagination where appropriate.

The API must define hard maximum page sizes.

Clients must never be able to request an unbounded dump accidentally.

## 7. Time-series bounds

Measurement APIs impose:

- maximum requested range per resolution;
- maximum measurements per request;
- maximum series count;
- maximum points per series;
- controlled resolution selection.

The server may automatically select a coarser resolution to stay within contract bounds.

## 8. Null and unknown

JSON numeric fields that are unknown/unavailable remain `null` or are omitted according to the endpoint schema.

They are never serialized as numeric zero solely for display convenience.

Coverage metadata explains why a point may be unavailable.

## 9. Semantics metadata

Measurement and record responses should expose or link to:

- source class;
- observation basis;
- `represents`;
- `doesNotRepresent`;
- time basis;
- source scope.

This enables CİTEM UI to remain epistemically precise without hard-coding source explanations in every component.

## 10. Caching and freshness

Read APIs may use bounded caching for performance. Responses that can be cached should expose generation/freshness metadata so CİTEM can tell users how current the picture is.

## 11. Error contract

Errors should be machine-readable and bounded, with stable codes such as:

- invalid request;
- unsupported measurement;
- range too large;
- unauthorized;
- unavailable dependency;
- internal error.

Provider-specific credentials or sensitive upstream response bodies must not leak through API errors.

## 12. Future client sync

A later endpoint may support incremental client cache synchronization using a Node-owned change cursor. NODE-0 reserves this capability but does not require implementation in NODE-1.

## 13. ANLAK boundary

Future endpoints may add `/v1/osint/...` without changing TechINT semantics. CİTEM-specific endpoints must not become a de facto universal canonical API.
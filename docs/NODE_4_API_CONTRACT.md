# NODE-4 versioned read API

Successful responses use `{ apiVersion, generatedAt, data, meta }`; `meta.requestId` is present on the shared NODE-4 boundary. Controlled errors additionally contain `{ error: { code, message } }` and never contain stacks or secrets.

Authenticated v1 routes include source metadata/status; the measurement catalogue, series, distributions, comparison and coverage APIs; factual changes; bounded entity and canonical-record reads; summary; and measurement provenance. Query bounds from NODE-3 remain authoritative. Record reads accept only `sourceKey`, `recordKind`, `entityId`, `from`, `to`, opaque `cursor`, and a limit of 1–100.

Summary presets are `24H`, `7D`, and `30D`. Summary and changes are factual read models and never emit a global threat/risk score or causal/attribution claims. Missing acquisition coverage remains unavailable, never an invented zero.

Stable errors include `UNAUTHORIZED`, `INVALID_REQUEST`, `UNSUPPORTED_MEASUREMENT`, `UNSUPPORTED_DIMENSION`, `RANGE_TOO_LARGE`, `POINT_LIMIT_EXCEEDED`, `NOT_FOUND`, `DEPENDENCY_UNAVAILABLE`, `METHOD_NOT_ALLOWED`, and `INTERNAL_ERROR`.

# NODE-4 API authentication

All `/v1/sources*` and `/v1/techint/*` endpoints require `Authorization: Bearer <credential>`. `X-BAYKUSH-CLIENT` is optional audit metadata and never authenticates a request. The API expects `BAYKUSH_NODE_API_TOKEN` to contain at least 32 UTF-8 bytes; an absent, blank, or weak value leaves protected routes fail-closed.

The credential is server-to-server only. It is never logged, returned, persisted, or exposed through a browser environment variable. Production callers must use HTTPS/TLS. Localhost HTTP is only a development transport.

`GET /v1/health` is intentionally public and returns only liveness plus the API version. Operational details are available through authenticated source status.

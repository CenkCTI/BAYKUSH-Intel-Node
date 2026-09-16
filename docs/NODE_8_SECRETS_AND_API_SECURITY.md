# NODE-8 — Secrets, service authentication & API edge policy

## Secret boundary

Production credentials are host-private files. They are not committed to Git, embedded in images, returned by APIs, written to canonical/raw intelligence state or exposed to browser code.

The runtime image already runs as the non-root `node` user, so production secrets use a dedicated **non-interactive numeric supplemental group** rather than making root-only files unreadable inside the container. Do not add human login users to this group.

Example host layout with `BAYKUSH_SECRET_GID=2000`:

```text
/etc/baykush/
  runtime.env                 # root:root 0600; paths/limits only
  secrets/                    # root:2000 0750
    postgres_password         # root:2000 0440
    database_url              # root:2000 0440; role-specific in NODE-8C
    api_credentials.json      # root:2000 0440
    smoke_api_token           # root:2000 0440; host-only active scoped credential
    nvd_api_key               # optional root:2000 0440
    threatfox_auth_key        # optional root:2000 0440
    malwarebazaar_auth_key    # optional root:2000 0440
    ipinfo_lite_token         # optional root:2000 0440
```

The production Compose stack mounts the secret directory read-only at `/run/secrets/baykush` and adds only the configured supplemental GID to Node/PostgreSQL containers. Normal runtime environment variables contain only secret **paths**. A tiny PID-1 wrapper resolves provider/database files immediately before the Node process is executed so raw secret values do not appear in the Compose model or Docker container configuration.

The API credential registry is read directly from its mounted file and never needs to be exported as a process environment value.

The initial NODE-8B stack mounts the common secret directory read-only. NODE-8C narrows database credentials by service/role; later runtime hardening may further split provider-secret mounts where operationally useful.

## Development compatibility

Existing development variables such as `BAYKUSH_NODE_API_TOKEN`, `DATABASE_URL` and provider-key environment variables remain supported for local/test workflows. Production uses the file-backed contract.

For any secret, direct value and `_FILE` value are mutually exclusive. Ambiguous configuration fails closed.

## API credential registry

Production uses a bounded JSON registry:

```json
{
  "credentials": [
    {
      "id": "citem-production-2026-01",
      "token": "<random value >= 32 UTF-8 bytes>",
      "scopes": ["techint:read", "sources:read"]
    }
  ]
}
```

Rules:

- at most 16 active credentials;
- credential IDs are unique, non-secret audit identities;
- tokens contain at least 32 UTF-8 bytes and at most 4096;
- unknown scopes are rejected;
- a missing/invalid registry leaves protected routes fail-closed;
- credentials are compared by timing-safe SHA-256 digests;
- response bodies never echo supplied credentials.

## Scopes

- `techint:read` — `/v1/techint/*`;
- `sources:read` — `/v1/sources*`;
- `ops:read` — reserved for NODE-8 operational endpoints.

A valid credential without the required scope receives `403 FORBIDDEN`. Missing or invalid authentication receives `401 UNAUTHORIZED`.

`GET /v1/health` remains intentionally public and minimal.

## Zero-downtime rotation

Credential rotation is additive before it is subtractive:

1. registry contains credential **A**;
2. generate credential **B** out of band;
3. update registry to contain **A + B**;
4. reload/redeploy the API and verify both credentials;
5. update CİTEM production server configuration to **B**;
6. run authenticated CİTEM/Node acceptance with **B**;
7. update the host-only smoke token to **B**;
8. remove **A** from the Node registry;
9. verify **A** returns 401 and **B** still succeeds.

The same pattern applies to future BAYKUSH server-to-server consumers with separate IDs/scopes.

## Rate limiting

Authenticated requests are limited per credential ID rather than source IP because the Node is a server-to-server API behind a reverse proxy.

Defaults:

- window: 60 seconds;
- normal protected requests: 120/window;
- expensive lineage/related/routing-context/convergence requests: 30/window.

Limits are intentionally bounded and configurable. A rejected request returns `429 RATE_LIMITED` plus `Retry-After` and never includes the credential value.

The in-memory limiter is an initial single-host control. It does not claim distributed global-rate semantics. If Node becomes multi-replica, the limiter must move to shared state or an authoritative edge limiter.

## Browser boundary

The Node is not a browser API. CİTEM calls it server-to-server. Node does not emit `Access-Control-Allow-Origin`, and credential-bearing browser calls are not part of the supported production contract.

Responses include defensive headers (`nosniff`, frame denial, no-referrer, restrictive CSP and permissions policy). Caddy adds the HTTPS/HSTS edge headers independently.

## Logging and audit

Safe audit fields may include:

- request ID;
- credential ID after successful authentication;
- endpoint class;
- response status;
- duration.

Never log:

- bearer values;
- registry contents;
- authorization headers;
- provider/database secrets;
- full unsafe upstream bodies.

`X-BAYKUSH-CLIENT` remains optional descriptive metadata only and never authenticates a request.

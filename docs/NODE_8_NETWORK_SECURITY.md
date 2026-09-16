# NODE-8E — Network and upstream hardening

## Mission

Keep the Node's external network surface small and make upstream collection fail closed when a configured provider endpoint attempts to cross into private, loopback, link-local, metadata or other reserved address space.

## Ingress boundary

Production ingress remains:

- Caddy on 80/443;
- Node API 8080 exposed only inside Docker networks;
- PostgreSQL exposed only on the backend Docker network;
- browser-to-Node authenticated API access is unsupported; CİTEM is server-to-server.

`network-audit.sh` validates the Compose publishing surface and rejects wildcard host listeners for PostgreSQL 5432 or Node API 8080. Cloud firewall/Oracle NSG and host firewall remain separate defense layers and must mirror the same policy.

## Upstream HTTP boundary

The existing source transport already requires:

- HTTPS;
- no URL-embedded credentials;
- exact admitted provider hostname;
- exact admitted path;
- manual/non-followed redirects;
- bounded request bodies;
- bounded response bodies;
- bounded timeout;
- controlled status/error classification;
- bounded/redacted provider diagnostics.

NODE-8E adds public-destination enforcement:

- literal IPv4/IPv6 private, loopback, link-local, carrier-grade NAT, documentation, multicast and reserved destinations are rejected before transport;
- local/metadata hostname classes are rejected;
- production use of the native fetch transport resolves the provider hostname and rejects the request if any resolved address is non-public;
- DNS resolution failure becomes a bounded retryable transport failure;
- deterministic tests may inject a resolver and fake transport without using external DNS.

The DNS check is defense-in-depth on top of the more important fixed-provider allowlist. It is not a claim that application-level pre-resolution alone cryptographically pins subsequent DNS answers; the fixed admitted hostname/path contract remains mandatory.

## Oracle/host network policy

The first real host should use two independent filters:

1. Oracle Network Security Group/security-list rules;
2. host firewall (UFW/nftables).

Expected public ingress is 80/443. SSH 22 should be limited to the operator's management address/range when operationally possible. Ports 5432 and 8080 must never be internet-reachable.

Outbound traffic is intentionally not hardcoded to provider IP ranges because several authoritative sources use CDNs and rotating public addresses. The application allowlist and public-address validation are therefore the primary provider egress control. A future fixed egress proxy may tighten this without embedding fragile IP lists in Node.

## Acceptance

NODE-8E is accepted when:

- fixed-provider URL tests continue to pass;
- private/reserved literal targets are rejected before transport;
- private/reserved DNS answers are rejected;
- DNS failures remain controlled/retryable and do not advance checkpoints;
- secrets are absent from network error messages;
- production Compose publishes only Caddy;
- host audit finds no wildcard 5432/8080 listeners;
- CORS remains closed and service credentials remain server-side;
- all NODE-0–7 semantic regressions remain green.

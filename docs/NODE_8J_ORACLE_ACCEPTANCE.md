# NODE-8J — Oracle production acceptance and final closure tooling

## Status and scope

NODE-8J supplies provider-independent host preflight, bounded manual evidence recording, and the final fail-closed NODE-8 evidence aggregator. It does not deploy to Oracle and requires no Oracle SDK or CLI. **CI green != production accepted. NODE-8I automated acceptance != Oracle host acceptance. NODE-8J remains `MANUAL_PENDING` until every real-host gate passes.**

The tooling consumes NODE-8A packaging, NODE-8B file-backed secrets/scoped auth, NODE-8C database roles, NODE-8D runtime hardening, NODE-8E network controls, NODE-8F backup/restore, NODE-8G operations evidence, NODE-8H release evidence, and NODE-8I resilience evidence. Those controls remain authoritative.

## Safety and host assumptions

The supported target is Ubuntu 24.04 LTS on amd64/x86_64 with systemd, synchronized time, Docker Engine and the Compose plugin. Root or sudo is needed for installation and ownership enforcement. Default paths are `/opt/baykush-node`, `/etc/baykush`, and `/var/lib/baykush`; disk minimum defaults to 20 GiB and is configurable with `NODE8J_MIN_DISK_GIB`. Production secrets remain root-owned, directories mode `0750`, and files mode `0440`. Only Caddy publishes TCP 80/443; PostgreSQL 5432 and Node API 8080 are never public.

Never use these procedures to delete volumes, rewrite migration history, expose credentials, fill a system disk, or disrupt an unrelated host. Use a scheduled window and a designated production or disposable replacement environment. Evidence notes and attachments must not contain credentials.

## Deployment and preflight sequence

1. Provision DNS, firewall/security-list ingress for 80/443 only, Docker/systemd, directories and file-backed secrets according to `NODE_8_DEPLOYMENT_CONTRACT.md`.
   Install `scripts/node8j-evidence.mjs`, `scripts/node8j-final-acceptance.mjs`, and `scripts/node8j-record-manual.mjs` beside the production shell scripts under `/opt/baykush-node/scripts`.
2. Select the immutable `repository@sha256:<64 hex>` release and install the production bundle.
3. Run `oracle-host-preflight.sh` before deployment; resolve every `FAIL` and manually adjudicate every `MANUAL_REVIEW`. Save its `NODE8_ORACLE_HOST_PREFLIGHT_V1` JSON without editing it.
4. Run the NODE-8H deploy transaction. Preserve accepted release, backup, runtime and network evidence.
5. Execute the real-host matrix below and record each scenario.
6. Obtain separate CİTEM cutover evidence, then run `final-acceptance.sh`.

Preflight is read-only: it identifies Linux/OS/architecture, privilege readiness, Docker/Compose/systemd/time state, disk capacity, directory readiness, port listeners, secret-policy readiness, required files, digest pinning and Compose validity. `PASS`, `FAIL`, and `MANUAL_REVIEW` are machine-readable. It prints no environment or secret values.

## Real-host acceptance matrix

The final schema has 21 mandatory gates: Oracle preflight; exact deployed digest; Caddy HTTPS; intended ingress; no public 5432; no public 8080; secret modes; NODE-8D runtime audit; network audit; scoped API auth; DB least privilege; real encrypted off-host backup; replacement-host restore; VM restart; Docker-daemon restart; Internet outage; backup-target outage; disk pressure; safe service restarts; bounded host load; and CİTEM cutover.

The strict recorder scenarios are `VM_RESTART`, `DOCKER_DAEMON_RESTART`, `INTERNET_OUTAGE`, `BACKUP_TARGET_OUTAGE`, `DISK_PRESSURE`, `RESTORE_DRILL`, `SAFE_SERVICE_RESTARTS`, `BOUNDED_HOST_LOAD`, `CITEM_CUTOVER`, `TLS_NETWORK_ACCEPTANCE`, `SECURITY_BOUNDARIES`, and `OFFHOST_BACKUP`. Example:

```sh
sudo NODE8J_SCENARIO=VM_RESTART NODE8J_RESULT=PASS \
  NODE8J_HOST_ID=oracle-node-prod-01 \
  NODE8J_RELEASE_IMAGE='ghcr.io/example/node@sha256:…' \
  NODE8J_OPERATOR_NOTE='scheduled reboot; durable checks completed' \
  NODE8J_EVIDENCE_DIR=/var/lib/baykush/acceptance/manual \
  /opt/baykush-node/scripts/record-manual-acceptance.sh
```

Optional colon-separated `NODE8J_REFERENCE_FILES` are recorded only by basename and SHA-256; contents are not copied. Unknown scenario names, non-PASS/FAIL results, invalid hosts/digests and credential-like fields/content are rejected.

## Fault and recovery contracts

**VM restart.** Before reboot capture release digest, migration ledger, row/fingerprint/provenance baselines, checkpoints and ops state. After an operator-initiated reboot verify systemd/Docker starts, expected restart policies recover PostgreSQL and services, durable PostgreSQL/raw/canonical/provenance state survives, checkpoints do not falsely advance, health accurately transitions to recovery, secrets require no unexpected re-entry, and every running Node container still uses the intended digest.

**Docker daemon restart.** During a scheduled window capture the same durable baseline, restart only the real daemon, observe honest unhealthy/unavailable transitions, then verify service recovery, DB durability, provenance retention, no false successful coverage/checkpoints, and configured restart policies. The development machine is never a test target.

**Internet outage.** Use a reversible host firewall/security-list control in a maintenance window while preserving operator access. Block provider egress, not local DB/runtime traffic. Confirm acquisitions become degraded/failed, success checkpoints do not advance, prior provenance remains, no fake zero/no-activity is emitted, and local Node functions remain available. Restore connectivity and prove acquisition resumes from durable state without duplicate/corrupt canonical history.

**Backup-target outage.** Temporarily deny only the configured off-host repository. Prove backup failure is visible, the release backup gate fails closed, no accepted backup evidence is written, intelligence state remains intact, and ops reports degraded/unknown backup state. Restore access and verify a later real backup independently.

**Disk pressure.** Never fill the system or PostgreSQL filesystem. Use a bounded disposable loop-backed filesystem, quota-controlled test mount, or separately sized test volume with an explicit cleanup limit. Point only a disposable backup/staging target at it. Cross warning then critical thresholds; prove ops state changes, no intelligence success is fabricated, insufficient-space backup fails visibly, and database integrity remains valid. Remove the bounded artifact after capturing evidence.

**Replacement-host restore.** On a separate isolated/replacement environment retrieve the encrypted off-host snapshot, validate restic/manifest/checksums, restore PostgreSQL, match the migration ledger and data fingerprints, verify raw/canonical/provenance/checkpoint data and immutable revision protections, start services against restored state, and prove collection resumes from the durable checkpoint. Backup success alone never satisfies restore acceptance.

## TLS, security, and CİTEM evidence

From an external probe verify the certificate and HTTPS endpoint through Caddy, expected 80/443 ingress, no reachable 5432/8080, and no unexpected public service ports. Do not hardcode Oracle IP ranges. On-host rerun runtime/network audits, auth negative/scope tests, DB-role acceptance, secret ownership/mode checks, and bind all evidence to the deployed digest.

CİTEM is a separate repository and is not changed by NODE-8J. It must emit `CITEM_NODE8_CUTOVER_EVIDENCE_V1` with `result: PASS`, the exact release digest, and booleans proving: server-to-server HTTPS; token server-only and absent from browsers; least intended scope; real Node data observed; Node unavailability rendered explicit degraded/unknown and never zero/no activity; no ability to mutate canonical truth; safe authentication failure; and a working end-to-end read path. This evidence plus the `CITEM_CUTOVER` manual record is mandatory.

## Final aggregator, failure, and rollback

Run the wrapper with `--expected-image=…` plus paths for `--release`, `--backup`, `--restore`, `--operations`, `--resilience`, `--preflight`, `--citem`, and `--manual-dir`. Output is `NODE8_PRODUCTION_ACCEPTANCE_V1`. Missing mandatory evidence yields `MANUAL_PENDING` (exit 2), explicit failure yields `FAILED` (exit 1), and only a complete coherent set yields `ACCEPTED`. Digest mismatch, malformed/wrong schemas, duplicate scenarios and suspected secrets fail validation. Synthetic test fixtures are labeled synthetic and are not production evidence.

On failure, preserve evidence and state, diagnose without weakening gates, and use the NODE-8H application-only rollback only when schema compatibility is explicitly verified. Never down-migrate. Restore is a separately verified disaster-recovery operation.

## Semantic closure invariants

Final acceptance requires: unknown != zero; no coverage != no activity; reporting volume != attack volume; BGP UPDATE != incident/attack/outage/hijack; geography != attacker origin; failure must not fabricate successful coverage or advance a successful checkpoint; recovery must preserve provenance; backup success != restore success; runtime health != threat level. A demonstrated violation is a failed gate.

NODE-8 is production `ACCEPTED` only after all 21 gates contain valid, same-release, real-host evidence and the independent CİTEM cutover contract passes. Until then the status is `MANUAL_PENDING` / not accepted.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SCENARIOS = Object.freeze([
  "VM_RESTART", "DOCKER_DAEMON_RESTART", "INTERNET_OUTAGE",
  "BACKUP_TARGET_OUTAGE", "DISK_PRESSURE", "RESTORE_DRILL",
  "SAFE_SERVICE_RESTARTS", "BOUNDED_HOST_LOAD", "CITEM_CUTOVER",
  "TLS_NETWORK_ACCEPTANCE", "SECURITY_BOUNDARIES", "OFFHOST_BACKUP",
]);
export const SEMANTIC_INVARIANTS = Object.freeze([
  "unknown != zero", "no coverage != no activity", "reporting volume != attack volume",
  "BGP UPDATE != incident/attack/outage/hijack", "geography != attacker origin",
  "failure must not fabricate successful coverage", "failure must not advance a successful checkpoint",
  "recovery must preserve provenance", "backup success != restore success", "runtime health != threat level",
]);
export const REQUIRED_GATES = Object.freeze([
  "ORACLE_HOST_PREFLIGHT", "EXACT_RELEASE_DIGEST", "TLS_HTTPS_CADDY", "INTENDED_HOST_INGRESS",
  "POSTGRES_NOT_PUBLIC", "NODE_API_NOT_PUBLIC", "SECRET_PERMISSIONS", "RUNTIME_HARDENING",
  "NETWORK_AUDIT", "API_AUTH_SCOPES", "DB_LEAST_PRIVILEGE", "OFFHOST_BACKUP",
  "REPLACEMENT_HOST_RESTORE", "VM_RESTART", "DOCKER_DAEMON_RESTART", "INTERNET_OUTAGE",
  "BACKUP_TARGET_OUTAGE", "DISK_PRESSURE", "SAFE_SERVICE_RESTARTS", "BOUNDED_HOST_LOAD",
  "CITEM_CUTOVER",
]);

const digestPattern = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const forbiddenKey = /((^|[_-])(secret|password|credential|bearer|authorization|api[_-]?key|token)($|[_-])|(secret|password|credential|bearer|authorization|apiKey|token)(Value|Text|Content)$)/i;
const forbiddenValue = /(bearer\s+[A-Za-z0-9._~+/-]+=*|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);

export function assertNoSecrets(value, path = "evidence") {
  if (typeof value === "string" && forbiddenValue.test(value)) throw new Error(`${path} contains credential-like content`);
  if (Array.isArray(value)) return value.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`));
  if (plain(value)) for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey.test(key)) throw new Error(`${path}.${key} is a forbidden secret-bearing field`);
    assertNoSecrets(item, `${path}.${key}`);
  }
}
export function readJson(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  assertNoSecrets(value);
  return value;
}
export function validateManualEvidence(value, { expectedImage } = {}) {
  assertNoSecrets(value);
  if (!plain(value) || value.schemaVersion !== "NODE8J_MANUAL_EVIDENCE_V1") throw new Error("wrong manual evidence schema version");
  if (!SCENARIOS.includes(value.scenarioId)) throw new Error("scenario is not in the NODE-8J whitelist");
  if (!["PASS", "FAIL"].includes(value.result)) throw new Error("manual result must be PASS or FAIL");
  if (!Number.isFinite(Date.parse(value.observedAt))) throw new Error("manual evidence timestamp is invalid");
  if (typeof value.hostId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.hostId)) throw new Error("hostId is invalid");
  if (!digestPattern.test(value.releaseImage)) throw new Error("releaseImage must be digest-pinned");
  if (expectedImage && value.releaseImage !== expectedImage) throw new Error("manual evidence release digest does not match expected image");
  if (typeof value.operatorNote !== "string" || value.operatorNote.length > 1000) throw new Error("operatorNote is invalid");
  if (!Array.isArray(value.references) || value.references.some((r) => !plain(r) || !/^[0-9a-f]{64}$/.test(r.sha256) || typeof r.name !== "string" || r.name.length > 200)) throw new Error("references are invalid");
  return value;
}
export function createManualEvidence(input) {
  const evidence = { schemaVersion: "NODE8J_MANUAL_EVIDENCE_V1", scenarioId: input.scenarioId, result: input.result,
    observedAt: input.observedAt ?? new Date().toISOString(), operatorNote: input.operatorNote ?? "", hostId: input.hostId,
    releaseImage: input.releaseImage, references: input.references ?? [], containsSecrets: false };
  return validateManualEvidence(evidence, { expectedImage: input.releaseImage });
}
const accepted = (v, schema, predicate = (x) => x.accepted === true) => plain(v) && v.schemaVersion === schema && predicate(v);
export function aggregateAcceptance(input) {
  const { expectedImage, release, backup, restore, operations, resilience, preflight, manual = [], citem } = input;
  if (!digestPattern.test(expectedImage ?? "")) throw new Error("expected release image must be digest-pinned");
  [release, backup, restore, operations, resilience, preflight, citem, ...manual].filter(Boolean).forEach((v) => assertNoSecrets(v));
  for (const [name, value, schema] of [["release",release,"NODE8_RELEASE_EVIDENCE_V1"],["backup",backup,"NODE8_BACKUP_GATE_EVIDENCE_V1"],["restore",restore,"NODE8_RESTORE_ACCEPTANCE_V1"],["operations",operations,"NODE8_OPS_SNAPSHOT_V1"],["resilience",resilience,"NODE8I_RESILIENCE_ACCEPTANCE_V1"],["preflight",preflight,"NODE8_ORACLE_HOST_PREFLIGHT_V1"],["citem",citem,"CITEM_NODE8_CUTOVER_EVIDENCE_V1"]]) {
    if (value !== undefined && (!plain(value) || value.schemaVersion !== schema)) throw new Error(`${name} evidence has wrong schema version`);
  }
  const byScenario = new Map();
  for (const record of manual) { validateManualEvidence(record, { expectedImage }); if (byScenario.has(record.scenarioId)) throw new Error(`duplicate manual scenario: ${record.scenarioId}`); byScenario.set(record.scenarioId, record); }
  const releaseOk = accepted(release, "NODE8_RELEASE_EVIDENCE_V1", (x) => x.accepted === true && x.result === "ACCEPTED" && x.image === expectedImage && x.smokeAccepted === true && x.runtimeAuditAccepted === true && x.networkAuditAccepted === true);
  const preflightOk = accepted(preflight, "NODE8_ORACLE_HOST_PREFLIGHT_V1", (x) => x.result === "PASS" && x.releaseImage === expectedImage);
  const backupOk = accepted(backup, "NODE8_BACKUP_GATE_EVIDENCE_V1", (x) => x.accepted === true || x.durable === true);
  const restoreOk = accepted(restore, "NODE8_RESTORE_ACCEPTANCE_V1", (x) => x.accepted === true && x.provenanceVerified === true && x.immutableRevisionGuardsVerified === true);
  const opsOk = accepted(operations, "NODE8_OPS_SNAPSHOT_V1", (x) => x.status === "HEALTHY" && x.containsSecrets === false);
  const resilienceOk = accepted(resilience, "NODE8I_RESILIENCE_ACCEPTANCE_V1", (x) => x.automatedAccepted === true && x.result !== "FAILED");
  const citemOk = accepted(citem, "CITEM_NODE8_CUTOVER_EVIDENCE_V1", (x) => x.result === "PASS" && x.releaseImage === expectedImage && x.serverToServerHttps === true && x.nodeTokenServerOnly === true && x.browserBearerCredentialObserved === false && x.scopeRestricted === true && x.realNodeDataObserved === true && x.unavailabilityExplicitlyDegraded === true && x.unavailabilityReportedAsZero === false && x.canonicalMutationPossible === false && x.authFailureSafe === true && x.endToEndReadPath === true);
  const manualPass = (id) => byScenario.get(id)?.result === "PASS";
  const gates = {
    ORACLE_HOST_PREFLIGHT: preflightOk, EXACT_RELEASE_DIGEST: releaseOk, TLS_HTTPS_CADDY: manualPass("TLS_NETWORK_ACCEPTANCE"),
    INTENDED_HOST_INGRESS: manualPass("TLS_NETWORK_ACCEPTANCE"), POSTGRES_NOT_PUBLIC: preflightOk && manualPass("TLS_NETWORK_ACCEPTANCE"), NODE_API_NOT_PUBLIC: preflightOk && manualPass("TLS_NETWORK_ACCEPTANCE"),
    SECRET_PERMISSIONS: preflightOk && manualPass("SECURITY_BOUNDARIES"), RUNTIME_HARDENING: releaseOk && manualPass("SECURITY_BOUNDARIES"), NETWORK_AUDIT: releaseOk && manualPass("TLS_NETWORK_ACCEPTANCE"),
    API_AUTH_SCOPES: manualPass("SECURITY_BOUNDARIES"), DB_LEAST_PRIVILEGE: manualPass("SECURITY_BOUNDARIES"), OFFHOST_BACKUP: backupOk && manualPass("OFFHOST_BACKUP"),
    REPLACEMENT_HOST_RESTORE: restoreOk && manualPass("RESTORE_DRILL"), VM_RESTART: opsOk && manualPass("VM_RESTART"),
    DOCKER_DAEMON_RESTART: manualPass("DOCKER_DAEMON_RESTART"), INTERNET_OUTAGE: manualPass("INTERNET_OUTAGE"),
    BACKUP_TARGET_OUTAGE: manualPass("BACKUP_TARGET_OUTAGE"), DISK_PRESSURE: manualPass("DISK_PRESSURE"),
    SAFE_SERVICE_RESTARTS: resilienceOk && manualPass("SAFE_SERVICE_RESTARTS"), BOUNDED_HOST_LOAD: manualPass("BOUNDED_HOST_LOAD"),
    CITEM_CUTOVER: citemOk && manualPass("CITEM_CUTOVER"),
  };
  const explicitFailure = [release, backup, restore, operations, resilience, preflight, citem].some((v) => v && ["FAIL", "FAILED", "CRITICAL"].includes(v.result ?? v.status)) || manual.some((v) => v.result === "FAIL");
  const result = explicitFailure ? "FAILED" : REQUIRED_GATES.every((id) => gates[id]) ? "ACCEPTED" : "MANUAL_PENDING";
  return { schemaVersion: "NODE8_PRODUCTION_ACCEPTANCE_V1", result, accepted: result === "ACCEPTED", synthetic: input.synthetic === true,
    observedAt: new Date().toISOString(), expectedReleaseImage: expectedImage, gates: REQUIRED_GATES.map((id) => ({ id, status: gates[id] ? "PASS" : explicitFailure ? "FAIL_OR_MISSING" : "MANUAL_PENDING" })),
    semanticInvariants: SEMANTIC_INVARIANTS, evidenceSetSha256: createHash("sha256").update(JSON.stringify({ expectedImage, gates })).digest("hex"), containsSecrets: false,
    note: input.synthetic === true ? "SYNTHETIC CONTRACT VALIDATION ONLY — not production acceptance." : "ACCEPTED requires real Oracle-host and CİTEM cutover evidence; CI green is insufficient." };
}

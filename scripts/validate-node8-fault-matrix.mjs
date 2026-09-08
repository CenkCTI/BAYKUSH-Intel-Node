import fs from "node:fs";

const path = process.argv[2] ?? "deploy/production/acceptance/fault-matrix.json";
const requiredIds = [
  "VM_RESTART", "DOCKER_DAEMON_RESTART", "POSTGRES_RESTART", "API_RESTART", "WORKER_CRASH",
  "DISCOVERY_CRASH", "STREAM_WORKER_CRASH", "CADDY_RESTART", "INTERNET_OUTAGE", "DNS_FAILURE",
  "PROVIDER_429", "PROVIDER_TIMEOUT", "PROVIDER_5XX", "PROVIDER_SCHEMA_CHANGE", "BAD_API_CREDENTIAL",
  "MISSING_API_SCOPE", "RATE_LIMIT_EXCEEDED", "BACKUP_TARGET_OUTAGE", "DISK_PRESSURE", "RESTORE_DRILL",
];
const modes = new Set(["MANUAL_REAL_HOST", "SAFE_SERVICE_RESTART", "AUTOMATED_UNIT", "AUTOMATED_HTTP"]);
const realHostIds = new Set(["VM_RESTART", "DOCKER_DAEMON_RESTART", "INTERNET_OUTAGE", "BACKUP_TARGET_OUTAGE", "DISK_PRESSURE", "RESTORE_DRILL"]);
const fields = ["category", "executionMode", "preconditions", "injectedFailure", "expectedServiceState", "expectedRecoveryBehavior", "expectedSemanticBehavior", "expectedCheckpointBehavior", "expectedProvenanceBehavior", "evidenceRequirements"];

function validate(matrix) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(matrix?.schemaVersion === "NODE8_FAULT_MATRIX_V1", "unexpected fault matrix version");
  for (const semantic of ["unknownIsNotZero", "noCoverageIsNotNoActivity", "reportingVolumeIsNotAttackVolume", "bgpUpdateIsNotIncidentAttackOutageOrHijack", "geographyIsNotAttackerOrigin", "failureMustNotAdvanceSuccessfulCheckpoint", "recoveryMustPreserveProvenance", "failureMustNotFabricateSuccessfulCoverage", "restartMustPreserveDurableState"]) {
    check(matrix?.semantics?.[semantic] === true, `required semantic invariant missing: ${semantic}`);
  }
  check(Array.isArray(matrix?.scenarios), "scenarios must be an array");
  const scenarios = Array.isArray(matrix?.scenarios) ? matrix.scenarios : [];
  const ids = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const label = typeof scenario?.id === "string" ? scenario.id : `scenario[${index}]`;
    check(typeof scenario?.id === "string" && /^[A-Z0-9_]+$/u.test(scenario.id), `${label}: scenario id must be a stable uppercase token`);
    check(!ids.has(scenario?.id), `duplicate fault scenario ${label}`);
    ids.add(scenario?.id);
    for (const field of fields) {
      const value = scenario?.[field];
      const valid = Array.isArray(value) ? value.length > 0 && value.every((item) => typeof item === "string" && item.trim()) : typeof value === "string" && value.trim();
      check(Boolean(valid), `${label}: ${field} must not be empty`);
    }
    check(modes.has(scenario?.executionMode), `${label}: unsupported execution mode`);
    check(typeof scenario?.realHostRequired === "boolean", `${label}: realHostRequired must be boolean`);
    if (scenario?.executionMode === "SAFE_SERVICE_RESTART") check(typeof scenario.service === "string" && scenario.service.trim(), `${label}: service is required`);
    if (realHostIds.has(scenario?.id)) {
      check(scenario.realHostRequired === true, `${label}: real-host-only scenario must require a real host`);
      check(scenario.executionMode === "MANUAL_REAL_HOST", `${label}: real-host-only scenario cannot be marked automated`);
    }
    if (scenario?.realHostRequired === true) check(scenario.executionMode === "MANUAL_REAL_HOST", `${label}: required real-host evidence cannot be automated`);
  }
  for (const id of requiredIds) check(ids.has(id), `required fault scenario is missing: ${id}`);
  return { errors, scenarios };
}

let matrix;
let parseError = null;
try { matrix = JSON.parse(fs.readFileSync(path, "utf8")); } catch (error) { parseError = error instanceof Error ? error.message : String(error); }
const { errors, scenarios } = parseError ? { errors: [`matrix read/parse failed: ${parseError}`], scenarios: [] } : validate(matrix);
const accepted = errors.length === 0;
process.stdout.write(`${JSON.stringify({
  schemaVersion: "NODE8_FAULT_MATRIX_VALIDATION_V1",
  accepted,
  scenarioCount: scenarios.length,
  automatedScenarioCount: scenarios.filter((scenario) => scenario.executionMode !== "MANUAL_REAL_HOST").length,
  manualRealHostCount: scenarios.filter((scenario) => scenario.executionMode === "MANUAL_REAL_HOST").length,
  safeServiceRestartCount: scenarios.filter((scenario) => scenario.executionMode === "SAFE_SERVICE_RESTART").length,
  errors,
}, null, 2)}\n`);
if (!accepted) process.exitCode = 1;

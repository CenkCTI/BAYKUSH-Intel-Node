import fs from "node:fs";

const path = process.argv[2] ?? "deploy/production/acceptance/fault-matrix.json";
const matrix = JSON.parse(fs.readFileSync(path, "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(matrix.schemaVersion === "NODE8_FAULT_MATRIX_V1", "unexpected fault matrix version");
assert(matrix.semantics?.unknownIsNotZero === true, "fault matrix must preserve unknown != zero");
assert(matrix.semantics?.noCoverageIsNotNoActivity === true, "fault matrix must preserve no coverage != no activity");
assert(matrix.semantics?.failureMustNotAdvanceSuccessfulCheckpoint === true, "fault matrix must forbid checkpoint advancement on failure");
assert(matrix.semantics?.recoveryMustPreserveProvenance === true, "fault matrix must preserve provenance");
assert(Array.isArray(matrix.scenarios) && matrix.scenarios.length >= 15, "fault matrix is unexpectedly small");

const ids = new Set();
const modes = new Set(["MANUAL_REAL_HOST", "SAFE_SERVICE_RESTART", "AUTOMATED_UNIT", "AUTOMATED_HTTP"]);
for (const scenario of matrix.scenarios) {
  assert(typeof scenario.id === "string" && /^[A-Z0-9_]+$/u.test(scenario.id), "scenario id must be stable uppercase token");
  assert(!ids.has(scenario.id), `duplicate fault scenario ${scenario.id}`);
  ids.add(scenario.id);
  assert(modes.has(scenario.executionMode), `unsupported execution mode for ${scenario.id}`);
  assert(typeof scenario.destructive === "boolean", `${scenario.id} must declare destructive flag`);
  assert(Array.isArray(scenario.expected) && scenario.expected.length >= 2, `${scenario.id} must declare expected behavior`);
  if (scenario.executionMode === "SAFE_SERVICE_RESTART") assert(typeof scenario.service === "string", `${scenario.id} requires a service`);
}

for (const required of [
  "VM_RESTART", "POSTGRES_RESTART", "INTERNET_OUTAGE", "DNS_FAILURE", "PROVIDER_429",
  "PROVIDER_TIMEOUT", "PROVIDER_SCHEMA_CHANGE", "DISK_PRESSURE", "WORKER_CRASH",
  "DISCOVERY_CRASH", "STREAM_WORKER_CRASH", "BACKUP_TARGET_OUTAGE", "RESTORE_DRILL",
]) assert(ids.has(required), `required fault scenario is missing: ${required}`);

console.log(JSON.stringify({
  schemaVersion: "NODE8_FAULT_MATRIX_VALIDATION_V1",
  accepted: true,
  scenarioCount: matrix.scenarios.length,
  manualRealHostCount: matrix.scenarios.filter((s) => s.executionMode === "MANUAL_REAL_HOST").length,
  safeServiceRestartCount: matrix.scenarios.filter((s) => s.executionMode === "SAFE_SERVICE_RESTART").length,
}, null, 2));

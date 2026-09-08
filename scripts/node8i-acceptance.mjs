import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function execute(id, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return { id, status: result.status === 0 ? "AUTOMATED_ACCEPTED" : "FAILED", exitCode: result.status, output: (result.stdout || result.stderr || "").trim().slice(0, 4000) };
}
function consume(id, file, expectedSchema) {
  if (!file) return { id, status: "NOT_EXECUTED", reason: "environment/evidence file not supplied" };
  try {
    const evidence = JSON.parse(readFileSync(file, "utf8"));
    const accepted = evidence.schemaVersion === expectedSchema && (evidence.accepted === true || evidence.automatedAccepted === true);
    return { id, status: accepted ? "AUTOMATED_ACCEPTED" : "FAILED", evidenceFile: file, schemaVersion: evidence.schemaVersion };
  } catch (error) { return { id, status: "FAILED", evidenceFile: file, reason: error instanceof Error ? error.message : String(error) }; }
}

const matrix = JSON.parse(readFileSync("deploy/production/acceptance/fault-matrix.json", "utf8"));
const checks = [
  execute("fault-matrix", "node", ["scripts/validate-node8-fault-matrix.mjs"]),
  execute("provider-auth-load-negative", "npx", ["vitest", "run", "tests/node8i-resilience.test.ts"]),
  consume("safe-service-faults", process.env.NODE8I_FAULT_EVIDENCE_FILE, "NODE8_FAULT_ACCEPTANCE_V1"),
  consume("bounded-load", process.env.NODE8I_LOAD_EVIDENCE_FILE, "NODE8_LOAD_ACCEPTANCE_V1"),
];
const manualScenarios = matrix.scenarios.filter((scenario) => scenario.executionMode === "MANUAL_REAL_HOST").map((scenario) => ({ id: scenario.id, status: "MANUAL_PENDING" }));
const failed = checks.some((check) => check.status === "FAILED");
const evidence = {
  schemaVersion: "NODE8I_RESILIENCE_ACCEPTANCE_V1", result: failed ? "FAILED" : "MANUAL_PENDING",
  automatedAccepted: !failed, fullyAccepted: false, observedAt: new Date().toISOString(), checks, manualScenarios,
  semantics: matrix.semantics,
  note: "Local/CI automated acceptance is not Oracle real-host acceptance; manual scenarios remain for NODE-8J.",
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (failed) process.exitCode = 1;

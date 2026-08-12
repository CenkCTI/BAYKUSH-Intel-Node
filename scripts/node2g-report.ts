import { pool } from "../src/db/pool.js";
import { collectNode2Readiness, registryContractErrors } from "../src/node2g/readiness.js";

try {
  const readiness = await collectNode2Readiness(pool);
  const report = {
    schemaVersion: "NODE2_ACCEPTANCE_REPORT_V1",
    generatedAt: readiness.generatedAt,
    automatedReadiness: readiness,
    registryContractErrors: registryContractErrors(),
    manualGates: {
      commonPayloadParity: "PENDING_OPERATOR_EVIDENCE",
      liveShadowParity: "PENDING_OPERATOR_EVIDENCE",
      allFiveLiveAcceptance: "PENDING_OPERATOR_EVIDENCE",
      legacyCitemCollectorCutover: "PENDING_OPERATOR_EVIDENCE",
    },
    invariantReminder: [
      "Unknown != zero",
      "No coverage != no activity",
      "Reporting volume != attack volume",
      "IOC volume != attack count",
      "EPSS score != observed exploitation",
      "MalwareBazaar sample volume != infection prevalence",
      "NVD records != exploitation telemetry",
      "CISA KEV membership != exploit-event count",
      "Bootstrap ingestion != current technical activity",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = readiness.automatedReady && report.registryContractErrors.length === 0 ? 0 : 1;
} finally {
  await pool.end();
}

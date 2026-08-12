import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/db/pool.js";
import {
  collectNode2SecurityAudit,
  FORBIDDEN_CITEM_RUNTIME_ENV_NAMES,
  PROVIDER_SECRET_ENV_NAMES,
} from "../src/node2g/security-audit.js";

const forbiddenCitemTokens = [...FORBIDDEN_CITEM_RUNTIME_ENV_NAMES, "@supabase/"] as const;

function serviceBlock(compose: string, service: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === `  ${service}:`);
  assert.ok(start >= 0, `docker-compose service ${service} must exist`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[i] ?? "") || /^[A-Za-z0-9_-]+:$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile() && /\.(ts|js|mjs|json|yml|yaml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const compose = fs.readFileSync(process.env.NODE2G_COMPOSE_PATH ?? "docker-compose.yml", "utf8");
  const worker = serviceBlock(compose, "worker");
  for (const secretName of PROVIDER_SECRET_ENV_NAMES) {
    assert.ok(worker.includes(`${secretName}:`), `${secretName} must be injected into worker`);
    for (const service of ["migrate", "api", "scheduler", "normalizer"]) {
      assert.ok(!serviceBlock(compose, service).includes(`${secretName}:`), `${secretName} must not be injected into ${service}`);
    }
  }
  for (const token of forbiddenCitemTokens) {
    assert.ok(!compose.includes(token), `${token} must not be present in Node compose configuration`);
  }
  for (const file of walkFiles("src")) {
    const content = fs.readFileSync(file, "utf8");
    for (const token of forbiddenCitemTokens) {
      assert.ok(!content.includes(token), `${token} must not appear in Node runtime source: ${file}`);
    }
  }

  const runtime = await collectNode2SecurityAudit(pool);
  assert.equal(runtime.accepted, true, "NODE-2 runtime credential/private-boundary audit must pass");
  console.log(JSON.stringify({
    ...runtime,
    providerCredentialScope: "WORKER_ONLY_VERIFIED",
    composeStaticCheck: true,
    privateCitemSourceDependency: false,
  }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}

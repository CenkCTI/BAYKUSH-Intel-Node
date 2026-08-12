import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/db/pool.js";

const providerSecretNames = ["NVD_API_KEY", "THREATFOX_AUTH_KEY", "MALWAREBAZAAR_AUTH_KEY"] as const;
const forbiddenCitemTokens = ["SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "@supabase/"] as const;

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

async function persistedSecretOccurrences(secret: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT (
       (SELECT count(*) FROM raw_source_records
         WHERE position($1 in payload::text) > 0 OR position($1 in coalesce(source_url,'')) > 0)
       + (SELECT count(*) FROM canonical_evidence_records
         WHERE position($1 in facts::text) > 0
            OR position($1 in entities::text) > 0
            OR position($1 in reference_urls::text) > 0
            OR position($1 in semantic_boundary::text) > 0)
       + (SELECT count(*) FROM source_checkpoints WHERE position($1 in checkpoint::text) > 0)
       + (SELECT count(*) FROM collection_work_units
          WHERE position($1 in descriptor::text) > 0 OR position($1 in coalesce(failure_message,'')) > 0)
       + (SELECT count(*) FROM collection_runs WHERE position($1 in coalesce(failure_message,'')) > 0)
     )::int AS count`,
    [secret],
  );
  return result.rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const composePath = process.env.NODE2G_COMPOSE_PATH ?? "docker-compose.yml";
  const composeAvailable = fs.existsSync(composePath);

  if (composeAvailable) {
    const compose = fs.readFileSync(composePath, "utf8");
    const worker = serviceBlock(compose, "worker");
    const nonWorkerServices = ["migrate", "api", "scheduler", "normalizer"];

    for (const secretName of providerSecretNames) {
      assert.ok(worker.includes(`${secretName}:`), `${secretName} must be injected into worker`);
      for (const service of nonWorkerServices) {
        assert.ok(!serviceBlock(compose, service).includes(`${secretName}:`), `${secretName} must not be injected into ${service}`);
      }
    }
    for (const token of forbiddenCitemTokens) {
      assert.ok(!compose.includes(token), `${token} must not be present in Node compose configuration`);
    }
  }

  const sourceRoot = fs.existsSync("src") ? "src" : (fs.existsSync("dist") ? "dist" : null);
  if (sourceRoot) {
    for (const file of walkFiles(sourceRoot)) {
      const content = fs.readFileSync(file, "utf8");
      for (const token of forbiddenCitemTokens) {
        assert.ok(!content.includes(token), `${token} must not appear in Node runtime source: ${file}`);
      }
    }
  }

  const credentialPersistence: Record<string, number | "NOT_CONFIGURED"> = {};
  for (const secretName of providerSecretNames) {
    const secret = process.env[secretName];
    if (!secret) {
      credentialPersistence[secretName] = "NOT_CONFIGURED";
      continue;
    }
    const count = await persistedSecretOccurrences(secret);
    assert.equal(count, 0, `${secretName} must not be persisted in Node evidence/checkpoint/work state`);
    credentialPersistence[secretName] = count;
  }

  console.log(JSON.stringify({
    schemaVersion: "NODE2G_SECURITY_AUDIT_V1",
    accepted: true,
    providerCredentialScope: composeAvailable ? "WORKER_ONLY_VERIFIED" : "RUNTIME_PERSISTENCE_ONLY",
    composeStaticCheck: composeAvailable,
    privateCitemRuntimeDependency: false,
    credentialPersistence,
  }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}

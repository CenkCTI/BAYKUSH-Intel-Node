#!/usr/bin/env node
import fs from "node:fs";

const [containersPath, containersStatusPath, diskPath, diskStatusPath, apiPath, apiStatusPath,
  backupPath, backupStatusPath, out, warnRaw, criticalRaw, backupMaxRaw] = process.argv.slice(2);
const read = (path) => fs.readFileSync(path, "utf8").trim();
const parseJsonLoose = (text) => {
  if (!text) return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : [parsed]; }
  catch { return text.split(/\n+/u).filter(Boolean).map((line) => JSON.parse(line)); }
};
const finite = (value) => Number.isFinite(value) ? value : null;
const warn = Number(warnRaw), critical = Number(criticalRaw), backupMax = Number(backupMaxRaw);
if (!Number.isFinite(warn) || !Number.isFinite(critical) || warn < 1 || critical > 100 || warn >= critical) {
  throw new Error("disk thresholds must satisfy 1 <= warning < critical <= 100");
}
if (!Number.isFinite(backupMax) || backupMax <= 0) throw new Error("backup maximum age must be positive");

const checkStatus = {
  containers: read(containersStatusPath), disk: read(diskStatusPath),
  api: read(apiStatusPath), backup: read(backupStatusPath),
};
let containers = [];
try { containers = parseJsonLoose(read(containersPath)); } catch { checkStatus.containers = "failed"; }
const diskFields = read(diskPath).split(/\s+/u);
const diskPercent = checkStatus.disk === "ok" ? finite(Number((diskFields[4] ?? "").replace("%", ""))) : null;
if (diskPercent === null || diskPercent < 0 || diskPercent > 100) checkStatus.disk = "failed";
let api = null;
try { api = JSON.parse(read(apiPath)); } catch { checkStatus.api = "failed"; }
let backups = [];
try { backups = parseJsonLoose(read(backupPath)); } catch { checkStatus.backup = "failed"; }
const latest = backups.toSorted((a, b) => Date.parse(b.time ?? "") - Date.parse(a.time ?? ""))[0] ?? null;
const latestMs = latest?.time ? Date.parse(latest.time) : Number.NaN;
const backupAgeHours = Number.isFinite(latestMs) ? Math.max(0, (Date.now() - latestMs) / 3_600_000) : null;
const unhealthyContainers = containers.filter((item) => {
  const state = String(item.State ?? item.state ?? "").toLowerCase();
  const health = String(item.Health ?? item.health ?? "").toLowerCase();
  return state !== "running" || health === "unhealthy";
}).map((item) => item.Service ?? item.Name ?? item.name ?? "unknown");
const problems = [];
if (checkStatus.disk !== "ok") problems.push({ class: "DISK_UNKNOWN" });
else if (diskPercent >= critical) problems.push({ class: "DISK_CRITICAL", diskPercent });
else if (diskPercent >= warn) problems.push({ class: "DISK_WARNING", diskPercent });
if (checkStatus.api !== "ok" || (api?.data?.status !== "ok" && api?.status !== "ok")) problems.push({ class: "API_UNHEALTHY" });
if (checkStatus.containers !== "ok") problems.push({ class: "CONTAINERS_UNKNOWN" });
else if (containers.length === 0) problems.push({ class: "CONTAINERS_MISSING" });
else if (unhealthyContainers.length) problems.push({ class: "CONTAINER_UNHEALTHY", services: unhealthyContainers });
if (checkStatus.backup !== "ok" || backupAgeHours === null) problems.push({ class: "BACKUP_UNKNOWN" });
else if (backupAgeHours > backupMax) problems.push({ class: "BACKUP_STALE", backupAgeHours });
const criticalClasses = new Set(["DISK_CRITICAL", "API_UNHEALTHY", "CONTAINER_UNHEALTHY", "CONTAINERS_MISSING"]);
const evidence = {
  schemaVersion: "NODE8_OPS_SNAPSHOT_V1", observedAt: new Date().toISOString(),
  status: problems.some((problem) => criticalClasses.has(problem.class)) ? "CRITICAL" : problems.length ? "DEGRADED" : "HEALTHY",
  disk: { check: checkStatus.disk, usedPercent: diskPercent, warningPercent: warn, criticalPercent: critical },
  api: { check: checkStatus.api, reachable: checkStatus.api === "ok" && (api?.data?.status === "ok" || api?.status === "ok") },
  containers: { check: checkStatus.containers, count: containers.length, unhealthy: unhealthyContainers },
  backup: { check: checkStatus.backup, latestAt: latest?.time ?? null, ageHours: backupAgeHours, maxAgeHours: backupMax },
  problems,
  semantics: "Operational degradation only; it is not threat level, incident volume, adversary activity or attacker origin.",
  containsSecrets: false,
};
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

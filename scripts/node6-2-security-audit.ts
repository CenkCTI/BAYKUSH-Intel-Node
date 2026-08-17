import { readFile } from "node:fs/promises";

interface Check { check: string; accepted: boolean }
const read = (path: string) => readFile(path, "utf8");
const [fetcher,decoder,wrapper,compose,config,scanner,cli] = await Promise.all([
  read("src/recovery/fetcher.ts"),
  read("src/recovery/decoder.ts"),
  read("decoder/baykush-mrt-decoder/src/main.rs"),
  read("docker-compose.yml"),
  read("src/config.ts"),
  read("src/recovery/scanner.ts"),
  read("src/cli/node6.ts"),
]);
const checks: Check[] = [
  { check: "fixed-ripe-host", accepted: fetcher.includes('RIPE_MRT_HOST = "data.ris.ripe.net"') && fetcher.includes("RIPE_UPDATE_PATH") },
  { check: "manual-same-host-redirects", accepted: fetcher.includes('redirect: "manual"') && fetcher.includes("Cross-host MRT redirect rejected") },
  { check: "compressed-byte-integrity", accepted: fetcher.includes('"accept-encoding": "identity"') && fetcher.includes("assertGzipMagic") && fetcher.includes('createHash("sha256")') },
  { check: "decoder-no-shell", accepted: decoder.includes('spawn(config.recoveryDecoderPath') && decoder.includes("shell: false") && !decoder.includes("exec(") },
  { check: "decoder-local-file-only", accepted: wrapper.includes('input.contains("://")') && wrapper.includes("path.is_absolute()") },
  { check: "auto-recovery-default-off", accepted: config.includes("RECOVERY_AUTO_ENABLED:booleanFromEnv.default(false)") },
  { check: "planned-drain-excluded", accepted: scanner.includes("DRAIN_REQUESTED") },
  { check: "container-read-only", accepted: compose.includes("recovery-worker:") && compose.includes("read_only: true") },
  { check: "container-no-new-privileges", accepted: compose.includes("no-new-privileges:true") && compose.includes("cap_drop:") && compose.includes("- ALL") },
  { check: "bounded-runtime", accepted: compose.includes("pids_limit: 128") && compose.includes("mem_limit: 1g") && compose.includes("cpus: 1.0") },
  { check: "operator-cannot-supply-url", accepted: !cli.includes("--url") && !cli.includes("source-url") },
];
const accepted = checks.every((check) => check.accepted);
console.dir({ schemaVersion: "NODE6_2_SECURITY_AUDIT_V1", accepted, checks }, { depth: null });
if (!accepted) process.exitCode = 1;

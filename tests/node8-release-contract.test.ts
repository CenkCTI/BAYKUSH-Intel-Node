import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploy = readFileSync("deploy/production/scripts/deploy.sh", "utf8");
const rollback = readFileSync("deploy/production/scripts/rollback.sh", "utf8");
const evidence = readFileSync("deploy/production/scripts/release-evidence.sh", "utf8");
const selector = readFileSync("deploy/production/scripts/set-release-image.sh", "utf8");

describe("NODE-8 release and rollback contract", () => {
  it("serializes deploys and backs up durable state before migration", () => {
    expect(deploy).toContain("flock -n");
    expect(deploy).toContain("enforcing pre-migration encrypted backup gate");
    expect(deploy.indexOf('bash "$BACKUP_SCRIPT"')).toBeLessThan(deploy.indexOf("run --rm migrate"));
    expect(deploy.indexOf("run --rm migrate")).toBeLessThan(deploy.indexOf('bash "$DB_ROLE_SCRIPT"'));
    expect(deploy).toContain('bash "$RUNTIME_AUDIT_SCRIPT"');
    expect(deploy).toContain('bash "$NETWORK_AUDIT_SCRIPT"');
  });

  it("requires digest-pinned release identity and writes secret-free evidence", () => {
    expect(selector).toContain("@sha256:");
    expect(evidence).toContain("NODE8_RELEASE_EVIDENCE_V1");
    expect(evidence).toContain("migrationLedgerSha256");
    expect(evidence).toContain("containsSecrets: false");
  });

  it("rolls back application images without automatic database down-migration", () => {
    expect(rollback).toContain("NODE8_ROLLBACK_CONFIRM");
    expect(rollback).toContain("NODE8_ROLLBACK_SCHEMA_COMPATIBLE");
    expect(rollback).toContain("database schema is NOT rolled back");
    expect(rollback).not.toContain("down-migrate");
    expect(rollback).not.toContain("migration down");
  });
});

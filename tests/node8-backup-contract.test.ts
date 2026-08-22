import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backup = readFileSync("deploy/production/scripts/backup.sh", "utf8");
const restore = readFileSync("deploy/production/scripts/restore.sh", "utf8");
const timer = readFileSync("deploy/production/systemd/baykush-backup.timer", "utf8");
const envExample = readFileSync("deploy/production/env.example", "utf8");
const compose = readFileSync("deploy/production/compose.yml", "utf8");

describe("NODE-8 backup and recovery contract", () => {
  it("requires encrypted remote restic backup by default", () => {
    expect(backup).toContain("RESTIC_PASSWORD_FILE");
    expect(backup).toContain("production backup repository must be off-host");
    expect(backup).toContain("pg_dump");
    expect(backup).toContain("NODE8_BACKUP_MANIFEST_V1");
    expect(backup).toContain("includesSecrets: false");
  });

  it("requires explicit restore confirmation and protects the production database", () => {
    expect(restore).toContain("NODE8_RESTORE_CONFIRM");
    expect(restore).toContain("NODE8_RESTORE_PRODUCTION_CONFIRM");
    expect(restore).toContain("NODE8_RESTORE_ACCEPTANCE_V1");
    expect(restore).toContain("dump checksum mismatch");
    expect(restore).toContain("migration ledger checksum mismatch");
  });

  it("schedules a persistent six-hour backup cadence", () => {
    expect(timer).toContain("OnCalendar=*-*-* 00,06,12,18:15:00");
    expect(timer).toContain("Persistent=true");
  });

  it("keeps backup transport credentials outside container configuration", () => {
    expect(envExample).toContain("RESTIC_PASSWORD_FILE=/etc/baykush/secrets/restic_repository_password");
    expect(compose).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(compose).not.toContain("RESTIC_PASSWORD");
  });
});

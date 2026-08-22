import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { principalHasScope, requiredScopeForPath, type ApiPrincipal } from "../src/api/auth.js";

const opsApi = readFileSync("src/api/ops-api.ts", "utf8");
const opsSnapshot = readFileSync("deploy/production/scripts/ops-snapshot.sh", "utf8");

describe("NODE-8 operations boundary", () => {
  it("requires a dedicated ops scope for operational endpoints", () => {
    expect(requiredScopeForPath("/v1/ops/health")).toBe("ops:read");
    const citem: ApiPrincipal = { id: "citem", scopes: ["techint:read", "sources:read"] };
    const operator: ApiPrincipal = { id: "operator", scopes: ["ops:read"] };
    expect(principalHasScope(citem, "ops:read")).toBe(false);
    expect(principalHasScope(operator, "ops:read")).toBe(true);
  });

  it("keeps operational semantics distinct from threat semantics", () => {
    expect(opsApi).toContain("Collection/provider pipeline health and freshness");
    expect(opsApi).toContain("Threat level, attack volume, adversary activity or victim impact");
    expect(opsApi).toContain("not evidence of zero workload");
  });

  it("produces bounded host evidence without embedding secrets", () => {
    expect(opsSnapshot).toContain("NODE8_OPS_SNAPSHOT_V1");
    expect(opsSnapshot).toContain("DISK_CRITICAL");
    expect(opsSnapshot).toContain("BACKUP_STALE");
    expect(opsSnapshot).toContain("containsSecrets: false");
  });
});

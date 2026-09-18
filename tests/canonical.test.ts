import { describe, expect, it } from "vitest";
import { canonicalEvidenceDraftSchema } from "../src/contracts/canonical.js";

function draft(options: { entityCount?: number; referenceCount?: number }) {
  return {
    recordKind: "SECURITY_ADVISORY",
    canonicalKey: "security-advisory:canonical-boundary-fixture",
    entities: Array.from({ length: options.entityCount ?? 0 }, (_, index) => ({
      kind: "CVE",
      key: `CVE-2026-${String(10_000 + index)}`,
    })),
    facts: [],
    references: Array.from(
      { length: options.referenceCount ?? 0 },
      (_, index) => `https://example.test/references/${index}`,
    ),
  };
}

describe("canonical evidence draft bounds", () => {
  it("accepts a production-sized draft with 544 CVE entities", () => {
    expect(canonicalEvidenceDraftSchema.parse(draft({ entityCount: 544 })).entities).toHaveLength(544);
  });

  it("rejects a draft above the defensive entity ceiling", () => {
    expect(canonicalEvidenceDraftSchema.safeParse(draft({ entityCount: 4_097 })).success).toBe(false);
  });

  it("accepts the source-normalizer ceiling of 100 references", () => {
    expect(canonicalEvidenceDraftSchema.parse(draft({ referenceCount: 100 })).references).toHaveLength(100);
  });

  it("rejects a draft above the defensive reference ceiling", () => {
    expect(canonicalEvidenceDraftSchema.safeParse(draft({ referenceCount: 129 })).success).toBe(false);
  });
});

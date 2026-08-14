import { describe, expect, it } from "vitest";

import type { CurrentSourceAdmission } from "../src/sources/admission/contracts.js";
import { validateAdmissionForEnable } from "../src/sources/admission/policy.js";

function admission(overrides: Partial<CurrentSourceAdmission> = {}): CurrentSourceAdmission {
  return {
    sourceKey: "TEST_SOURCE",
    displayName: "Test Source",
    enabled: false,
    revisionId: "00000000-0000-4000-8000-000000000001",
    revisionNumber: 1,
    policyVersion: "v1",
    admissionStatus: "ADMITTED",
    valueQuestion: "What distinct technical evidence does this source contribute?",
    officialAccessReference: "https://example.com/feed",
    termsReference: "https://example.com/terms",
    termsCheckedAt: "2026-08-13T00:00:00.000Z",
    reviewDueAt: "2027-02-13T00:00:00.000Z",
    licenseClass: "TEST_LICENSE",
    commercialUseStatus: "ALLOWED",
    redistributionStatus: "RESTRICTED",
    rawRetentionStatus: "ALLOWED",
    canonicalRetentionStatus: "ALLOWED",
    derivedDataStatus: "ALLOWED",
    publicDisplayStatus: "RESTRICTED",
    attributionRequirement: null,
    collectionAllowed: true,
    canonicalProjectionAllowed: true,
    measurementProjectionAllowed: true,
    operatorConstraints: null,
    admissionSha256: "a".repeat(64),
    hashValid: true,
    reviewedAt: "2026-08-13T00:00:00.000Z",
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("NODE-5 source admission policy", () => {
  it("allows a current admitted source policy", () => {
    expect(validateAdmissionForEnable(admission(), new Date("2026-08-14T00:00:00Z"))).toEqual({ allowed: true, blockers: [] });
  });

  it("fails closed without admission", () => {
    expect(validateAdmissionForEnable(null).blockers).toContain("NO_CURRENT_ADMISSION");
  });

  it("blocks non-production lifecycle states", () => {
    for (const status of ["EXPERIMENTAL", "PAUSED", "REJECTED", "RETIRED"] as const) {
      expect(validateAdmissionForEnable(admission({ admissionStatus: status })).allowed).toBe(false);
    }
  });

  it("blocks unknown raw retention and overdue review", () => {
    const result = validateAdmissionForEnable(
      admission({ rawRetentionStatus: "UNKNOWN", reviewDueAt: "2026-08-12T00:00:00.000Z" }),
      new Date("2026-08-13T00:00:00.000Z"),
    );
    expect(result.blockers).toContain("RAW_RETENTION_UNKNOWN");
    expect(result.blockers).toContain("ADMISSION_REVIEW_OVERDUE");
  });

  it("blocks invalid policy integrity", () => {
    expect(validateAdmissionForEnable(admission({ hashValid: false })).blockers).toContain("POLICY_HASH_INVALID");
  });
});

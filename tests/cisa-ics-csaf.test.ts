import { describe, expect, it } from "vitest";
import { canonicalEvidenceDraftSchema } from "../src/contracts/canonical.js";
import { cisaIcsCsafSchema, normalizeCisaIcsCsafPayload } from "../src/sources/cisa-ics-csaf.js";

function advisory(vulnerabilityCount: number): unknown {
  return {
    document: {
      category: "csaf_security_advisory",
      csaf_version: "2.0",
      title: "Large legitimate CISA ICS advisory fixture",
      publisher: { name: "CISA" },
      tracking: {
        id: "ICSA-23-348-10",
        initial_release_date: "2023-12-14T12:00:00Z",
        current_release_date: "2023-12-14T12:00:00Z",
        status: "final",
        version: "1.0.0",
      },
    },
    vulnerabilities: Array.from({ length: vulnerabilityCount }, (_, index) => ({
      cve: `CVE-2023-${String(10_000 + index)}`,
    })),
  };
}

describe("CISA ICS CSAF source", () => {
  it("accepts and preserves documents with more than 512 vulnerabilities", () => {
    const parsed = cisaIcsCsafSchema.parse(advisory(513));

    expect(parsed.vulnerabilities).toHaveLength(513);
    expect(parsed.vulnerabilities?.at(-1)?.cve).toBe("CVE-2023-10512");
  });

  it("normalizes an advisory with more than 256 CVEs into a valid canonical draft", () => {
    const source = cisaIcsCsafSchema.parse(advisory(544));
    const normalized = normalizeCisaIcsCsafPayload({
      kind: "CISA_ICS_CSAF_ADVISORY",
      source,
      sourcePath: "2023/icsa-23-348-10.json",
      sourceCommitSha: "a".repeat(40),
      blobSha: "b".repeat(40),
    })[0];
    const canonical = canonicalEvidenceDraftSchema.parse(normalized);

    expect(canonical.entities).toHaveLength(544);
    expect(canonical.entities.at(-1)?.key).toBe("CVE-2023-10543");
  });

  it("rejects documents above the defensive vulnerability ceiling", () => {
    expect(() => cisaIcsCsafSchema.parse(advisory(4_097))).toThrow(
      "CISA ICS CSAF vulnerabilities exceed defensive limit of 4096",
    );
  });
});

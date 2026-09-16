import { describe, expect, it } from "vitest";
import { cisaIcsCsafSchema } from "../src/sources/cisa-ics-csaf.js";

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

  it("rejects documents above the defensive vulnerability ceiling", () => {
    expect(() => cisaIcsCsafSchema.parse(advisory(4_097))).toThrow(
      "CISA ICS CSAF vulnerabilities exceed defensive limit of 4096",
    );
  });
});

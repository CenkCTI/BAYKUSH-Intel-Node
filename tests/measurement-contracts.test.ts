import { describe, expect, it } from "vitest";
import { measurementRegistrationSchema } from "../src/measurement/contracts.js";
import { measurementRegistry } from "../src/measurement/registry.js";
import { bucketForDate, bucketForInstant, parseDateOnly, parseRfc3339Instant } from "../src/measurement/time.js";

describe("NODE-3 measurement contracts", () => {
  it("registers unique, schema-valid immutable semantic contracts", () => {
    const keys = new Set<string>();
    for (const registration of measurementRegistry) {
      expect(() => measurementRegistrationSchema.parse({
        definition: registration.definition,
        calculation: registration.calculation,
      })).not.toThrow();
      expect(keys.has(registration.definition.measurementKey)).toBe(false);
      keys.add(registration.definition.measurementKey);
      expect(registration.definitionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(registration.calculationHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(keys.has("vulnerability.cisa_kev.additions")).toBe(true);
    expect(keys.has("vulnerability.nvd.publications")).toBe(true);
    expect(keys.has("exploitation.epss.scored_records")).toBe(true);
    expect(keys.has("ioc.threatfox.reporting_volume")).toBe(true);
    expect(keys.has("malware.malwarebazaar.sample_reporting")).toBe(true);
  });

  it("keeps date-only source facts at date precision", () => {
    expect(parseDateOnly("2026-08-13")).toBe("2026-08-13");
    expect(() => parseDateOnly("2026-02-30")).toThrow();
    expect(bucketForDate("2026-08-13")).toEqual({
      start: "2026-08-13T00:00:00.000Z",
      end: "2026-08-14T00:00:00.000Z",
      granularity: "DAY",
    });
  });

  it("uses deterministic UTC half-open buckets", () => {
    expect(bucketForInstant("2026-08-13T10:17:59.999Z", "FIVE_MINUTES")).toEqual({
      start: "2026-08-13T10:15:00.000Z",
      end: "2026-08-13T10:20:00.000Z",
      granularity: "FIVE_MINUTES",
    });
    expect(bucketForInstant("2026-08-13T10:59:59.999Z", "HOUR").start).toBe("2026-08-13T10:00:00.000Z");
    expect(bucketForInstant("2026-08-13T11:00:00.000Z", "HOUR").start).toBe("2026-08-13T11:00:00.000Z");
    expect(bucketForInstant("2026-08-13T23:59:59.999Z", "DAY").start).toBe("2026-08-13T00:00:00.000Z");
    expect(bucketForInstant("2026-08-14T00:00:00.000Z", "DAY").start).toBe("2026-08-14T00:00:00.000Z");
  });

  it("rejects timezone-less API instants", () => {
    expect(() => parseRfc3339Instant("2026-08-13T10:00:00")).toThrow();
    expect(parseRfc3339Instant("2026-08-13T12:00:00+02:00").toISOString()).toBe("2026-08-13T10:00:00.000Z");
  });
});

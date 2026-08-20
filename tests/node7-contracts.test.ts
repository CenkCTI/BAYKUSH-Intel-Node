import { describe, expect, it } from "vitest";
import {
  classifyNode7Convergence,
  classifyNode7NoveltyBasis,
  exactCanonicalSubject,
} from "../src/discovery/contracts.js";

describe("NODE-7 semantic contracts", () => {
  it("does not count two source systems from one upstream as multi-origin convergence", () => {
    const result = classifyNode7Convergence({
      sourceDefinitionCount: 2,
      upstreamOriginCount: 1,
      sourceClassCount: 1,
      timePrecision: "INSTANT",
      observationSpanSeconds: 120,
      concurrentWindowSeconds: 3_600,
    });

    expect(result.findingTypes).toContain("SOURCE_SYSTEM_OVERLAP");
    expect(result.findingTypes).not.toContain("MULTI_ORIGIN_CONVERGENCE");
    expect(result.findingTypes).not.toContain("CONCURRENT_MOVEMENT");
  });

  it("classifies distinct upstream origins and source classes without asserting causation", () => {
    const result = classifyNode7Convergence({
      sourceDefinitionCount: 3,
      upstreamOriginCount: 2,
      sourceClassCount: 2,
      timePrecision: "INSTANT",
      observationSpanSeconds: 1_800,
      concurrentWindowSeconds: 3_600,
    });

    expect(result.findingTypes).toEqual([
      "SOURCE_SYSTEM_OVERLAP",
      "MULTI_ORIGIN_CONVERGENCE",
      "CROSS_CLASS_CONVERGENCE",
      "CONCURRENT_MOVEMENT",
    ]);
  });

  it("never treats date precision as hour-level concurrency", () => {
    const result = classifyNode7Convergence({
      sourceDefinitionCount: 2,
      upstreamOriginCount: 2,
      sourceClassCount: 2,
      timePrecision: "DATE",
      observationSpanSeconds: 0,
      concurrentWindowSeconds: 3_600,
    });

    expect(result.concurrentEligible).toBe(false);
    expect(result.findingTypes).not.toContain("CONCURRENT_MOVEMENT");
  });

  it("allows only LIVE_INCREMENTAL to create current novelty", () => {
    expect(classifyNode7NoveltyBasis("LIVE_INCREMENTAL")).toBe("CURRENT");
    expect(classifyNode7NoveltyBasis("INITIAL_BOOTSTRAP")).toBe("HISTORICAL");
    expect(classifyNode7NoveltyBasis("RECOVERY")).toBe("HISTORICAL");
    expect(classifyNode7NoveltyBasis("HISTORICAL_BACKFILL")).toBe("HISTORICAL");
    expect(classifyNode7NoveltyBasis("RESYNC")).toBe("HISTORICAL");
    expect(classifyNode7NoveltyBasis("REPAIR")).toBe("HISTORICAL");
    expect(classifyNode7NoveltyBasis("SNAPSHOT_RECONSTRUCTION")).toBe("HISTORICAL");
  });

  it("uses exact type and canonical key as the subject identity", () => {
    expect(exactCanonicalSubject("IP", "ip:192.0.2.1")).toBe("IP\u0000ip:192.0.2.1");
    expect(exactCanonicalSubject("DOMAIN", "domain:example.com"))
      .not.toBe(exactCanonicalSubject("URL", "url:https://example.com/"));
  });
});

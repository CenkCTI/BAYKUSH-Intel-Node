import { describe, expect, it } from "vitest";
import { assertAdapterContract } from "../src/contracts/source.js";
import { createTestSyntheticAdapter } from "../src/sources/test-synthetic.js";

describe("TEST_SYNTHETIC adapter", () => {
  it("implements the source contract", () => {
    const adapter = createTestSyntheticAdapter({ recordsPerRun: 25, pageSize: 10 });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.definition.sourceKey).toBe("TEST_SYNTHETIC");
    expect(adapter.definition.enabledByDefault).toBe(false);
  });

  it("progresses in bounded pages with a durable nextSequence checkpoint", async () => {
    const adapter = createTestSyntheticAdapter({ recordsPerRun: 25, pageSize: 10 });
    let work = adapter.workDescriptorSchema.parse(await adapter.plan({ checkpoint: null }));
    const controller = new AbortController();

    const first = await adapter.fetch({ work, signal: controller.signal });
    expect(first.records).toHaveLength(10);
    expect(first.complete).toBe(false);
    expect(adapter.checkpointSchema.parse(first.nextCheckpoint)).toEqual({ nextSequence: 10 });

    work = adapter.workDescriptorSchema.parse(first.nextWork);
    const second = await adapter.fetch({ work, signal: controller.signal });
    expect(second.records).toHaveLength(10);
    expect(adapter.checkpointSchema.parse(second.nextCheckpoint)).toEqual({ nextSequence: 20 });

    work = adapter.workDescriptorSchema.parse(second.nextWork);
    const third = await adapter.fetch({ work, signal: controller.signal });
    expect(third.records).toHaveLength(5);
    expect(third.complete).toBe(true);
    expect(third.nextWork).toBeNull();
    expect(adapter.checkpointSchema.parse(third.nextCheckpoint)).toEqual({ nextSequence: 25 });
  });

  it("uses deterministic raw identities", async () => {
    const adapter = createTestSyntheticAdapter({ recordsPerRun: 1, pageSize: 1 });
    const work = await adapter.plan({ checkpoint: { nextSequence: 40 } });
    const result = await adapter.fetch({ work, signal: new AbortController().signal });
    expect(adapter.identifyRawRecord(result.records[0])).toBe("synthetic:40");
    expect(adapter.normalize(result.records[0])[0]?.recordKind).toBe("UNKNOWN");
  });
});

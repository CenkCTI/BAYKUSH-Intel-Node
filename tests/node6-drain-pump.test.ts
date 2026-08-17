import { describe, expect, it } from "vitest";
import { BoundedStreamQueue, SingleConsumerDrainPump } from "../src/stream/queue.js";

function message(value: string) {
  return { raw: value, receivedAt: new Date(0).toISOString(), bytes: Buffer.byteLength(value) };
}

describe("NODE-6 single-consumer stream drain pump", () => {
  it("drains consecutive bounded batches without waiting for another timer tick", async () => {
    const queue = new BoundedStreamQueue(20, 10_000);
    for (let index = 0; index < 8; index += 1) expect(queue.push(message(String(index)))).toBe(true);
    const batches: string[][] = [];
    const pump = new SingleConsumerDrainPump(queue, 3, 10_000, async (messages) => {
      batches.push(messages.map((item) => item.raw));
    });

    await pump.drain();

    expect(batches).toEqual([["0", "1", "2"], ["3", "4", "5"], ["6", "7"]]);
    expect(queue.size).toBe(0);
  });

  it("allows only one persistence consumer while a drain is active", async () => {
    const queue = new BoundedStreamQueue(20, 10_000);
    for (let index = 0; index < 6; index += 1) expect(queue.push(message(String(index)))).toBe(true);
    let concurrent = 0;
    let maxConcurrent = 0;
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const batches: number[] = [];
    const pump = new SingleConsumerDrainPump(queue, 2, 10_000, async (messages) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      batches.push(messages.length);
      if (batches.length === 1) await firstBlocked;
      concurrent -= 1;
    });

    const first = pump.drain();
    const second = pump.drain();
    expect(first).toBe(second);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(batches).toEqual([2, 2, 2]);
    expect(maxConcurrent).toBe(1);
    expect(queue.size).toBe(0);
  });

  it("leaves later queued batches intact when persistence fails explicitly", async () => {
    const queue = new BoundedStreamQueue(20, 10_000);
    for (let index = 0; index < 5; index += 1) expect(queue.push(message(String(index)))).toBe(true);
    const pump = new SingleConsumerDrainPump(queue, 2, 10_000, async () => {
      throw new Error("database unavailable");
    });

    await expect(pump.drain()).rejects.toThrow("database unavailable");
    expect(queue.size).toBe(3);
    expect(pump.running).toBe(false);
  });
});

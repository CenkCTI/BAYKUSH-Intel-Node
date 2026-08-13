import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("NODE-3 projection source enablement", () => {
  it("requires an enabled source for discovery and claiming", async () => {
    const runtime = await readFile("src/measurement/projection/runtime.ts", "utf8");
    const enabledPredicates = runtime.match(/source\.enabled = true/g) ?? [];

    expect(enabledPredicates).toHaveLength(3);
  });
});

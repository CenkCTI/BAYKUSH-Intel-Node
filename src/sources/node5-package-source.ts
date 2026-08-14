import type { SourceAdapter } from "../contracts/source.js";
import { createPackageAdvisoryAdapter } from "./package-advisory.js";

type Options = { fetchImpl?: typeof fetch; now?: () => number };

function providerInstant(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\.\d{3}Z$/, "Z") : value;
}

export function createNode5PackageSource(options: Options = {}): SourceAdapter {
  const adapter = createPackageAdvisoryAdapter(options);
  return {
    ...adapter,
    async plan(input) {
      const planned = await adapter.plan(input);
      if (typeof planned !== "object" || planned === null || Array.isArray(planned)) return planned;
      const work = planned as Record<string, unknown>;
      return {
        ...work,
        start: providerInstant(work.start),
        end: providerInstant(work.end),
      };
    },
    normalize(record) {
      return adapter.normalize({ kind: "REVIEWED_ADVISORY", source: record });
    },
  };
}

import type { SourceAdapter } from "../contracts/source.js";
import { createPackageAdvisoryAdapter } from "./package-advisory.js";

type Options = { fetchImpl?: typeof fetch; now?: () => number };

export function createNode5PackageSource(options: Options = {}): SourceAdapter {
  const adapter = createPackageAdvisoryAdapter(options);
  return {
    ...adapter,
    normalize(record) {
      return adapter.normalize({ kind: "REVIEWED_ADVISORY", source: record });
    },
  };
}

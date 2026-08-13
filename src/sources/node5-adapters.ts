import type { SourceAdapter } from "../contracts/source.js";
import { createPackageAdvisoryAdapter } from "./package-advisory.js";

export const node5Adapters: SourceAdapter[] = [
  createPackageAdvisoryAdapter(),
];

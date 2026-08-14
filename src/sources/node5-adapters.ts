import type { SourceAdapter } from "../contracts/source.js";
import { createNode5PackageSource } from "./node5-package-source.js";

export const node5Adapters: SourceAdapter[] = [
  createNode5PackageSource(),
];

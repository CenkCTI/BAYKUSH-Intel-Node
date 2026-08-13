import type { SourceAdapter } from "../contracts/source.js";
import { createNode5PackageSource } from "./node5-package-source.js";
import { createMitreAttackEnterpriseAdapter } from "./mitre-attack-enterprise.js";

export const node5Adapters: SourceAdapter[] = [
  createNode5PackageSource(),
  createMitreAttackEnterpriseAdapter(),
];

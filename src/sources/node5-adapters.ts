import type { SourceAdapter } from "../contracts/source.js";
import { createJvnIpediaAdapter } from "./jvn-ipedia.js";
import { createMitreAttackEnterpriseAdapter } from "./mitre-attack-enterprise.js";
import { createNode5PackageSource } from "./node5-package-source.js";

export const node5Adapters: SourceAdapter[] = [
  createNode5PackageSource(),
  createMitreAttackEnterpriseAdapter(),
  createJvnIpediaAdapter(),
];

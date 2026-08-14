import { describe, expect, it } from "vitest";
import { adapterRegistry } from "../src/sources/registry.js";
import { admissionPolicyRegistry } from "../src/sources/admission/registry.js";

const admittedNode5Sources = [
  "FEODO_TRACKER",
  "SSLBL_CERTIFICATE",
  "GITHUB_ADVISORY_REVIEWED",
  "MITRE_ATTACK_ENTERPRISE",
  "JVN_IPEDIA",
  "CISA_ICS_CSAF",
  "CERT_EU_SECURITY_ADVISORY",
  "SIEMENS_PRODUCTCERT_CSAF",
] as const;

const measurementAllowed = new Set([
  "FEODO_TRACKER",
  "SSLBL_CERTIFICATE",
  "GITHUB_ADVISORY_REVIEWED",
  "CISA_ICS_CSAF",
]);

describe("NODE-5 source expansion acceptance", () => {
  it("registers every admitted NODE-5 source with a current code policy", () => {
    for (const sourceKey of admittedNode5Sources) {
      expect(adapterRegistry.has(sourceKey), `${sourceKey} adapter`).toBe(true);
      expect(admissionPolicyRegistry.has(sourceKey), `${sourceKey} admission`).toBe(true);
    }
  });

  it("keeps every newly admitted source disabled by default", () => {
    for (const sourceKey of admittedNode5Sources) {
      expect(adapterRegistry.get(sourceKey)?.definition.enabledByDefault, sourceKey).toBe(false);
    }
  });

  it("limits measurement projection to explicitly admitted source roles", () => {
    for (const sourceKey of admittedNode5Sources) {
      const policy = admissionPolicyRegistry.get(sourceKey);
      expect(policy?.measurementProjectionAllowed, sourceKey).toBe(measurementAllowed.has(sourceKey));
    }
  });

  it("does not register URLhaus while its admission review remains blocked", () => {
    expect(adapterRegistry.has("URLHAUS")).toBe(false);
    expect(admissionPolicyRegistry.has("URLHAUS")).toBe(false);
  });

  it("does not permit duplicate source keys in the runtime registry", () => {
    const keys = [...adapterRegistry.keys()];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

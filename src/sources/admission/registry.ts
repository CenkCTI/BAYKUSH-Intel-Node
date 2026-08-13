import type { AdmissionPolicyDefinition } from "./contracts.js";
import { assertAdmissionPolicyDefinition } from "./policy.js";

const policies: readonly AdmissionPolicyDefinition[] = [];

for (const policy of policies) assertAdmissionPolicyDefinition(policy);

export const admissionPolicyRegistry = new Map<string, AdmissionPolicyDefinition>(
  policies.map((policy) => [policy.sourceKey, policy]),
);

export const registeredAdmissionPolicies = Object.freeze([...admissionPolicyRegistry.values()]);

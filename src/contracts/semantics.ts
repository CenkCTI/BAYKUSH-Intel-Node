import { z } from "zod";

export const observationBasisSchema = z.enum([
  "OBSERVED",
  "REPORTED",
  "PUBLISHED",
  "SCORED",
  "ENRICHED",
  "UNKNOWN",
]);
export type ObservationBasis = z.infer<typeof observationBasisSchema>;

export const sourceClassSchema = z.enum([
  "VULNERABILITY_DATABASE",
  "EXPLOITED_VULNERABILITY_CATALOG",
  "EXPLOIT_PROBABILITY",
  "IOC_SHARING",
  "MALWARE_SAMPLE_REPOSITORY",
  "OFFICIAL_ADVISORY",
  "CERT_CSIRT_REPORTING",
  "THREAT_RESEARCH",
  "CAMPAIGN_REPORTING",
  "INFRASTRUCTURE_TELEMETRY",
  "DNS_OBSERVATION",
  "CERTIFICATE_OBSERVATION",
  "ROUTING_TELEMETRY",
  "CONTEXT_KNOWLEDGE",
  "UNKNOWN",
]);
export type SourceClass = z.infer<typeof sourceClassSchema>;

export const semanticBoundarySchema = z.object({
  represents: z.string().min(1).max(2_000),
  doesNotRepresent: z.string().min(1).max(2_000),
});
export type SemanticBoundary = z.infer<typeof semanticBoundarySchema>;

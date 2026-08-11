import { z } from "zod";

export const canonicalRecordKindSchema = z.enum([
  "VULNERABILITY_RECORD",
  "KNOWN_EXPLOITED_VULNERABILITY",
  "EXPLOIT_PROBABILITY_SCORE",
  "IOC_REPORT",
  "MALWARE_SAMPLE_RECORD",
  "SECURITY_ADVISORY",
  "CERT_CSIRT_PUBLICATION",
  "THREAT_RESEARCH_REPORT",
  "INFRASTRUCTURE_OBSERVATION",
  "CONTEXT_KNOWLEDGE",
  "UNKNOWN",
]);
export type CanonicalRecordKind = z.infer<typeof canonicalRecordKindSchema>;

export const canonicalEntityKindSchema = z.enum([
  "CVE","IP","DOMAIN","URL","HASH","MALWARE","VENDOR","PRODUCT","PACKAGE",
  "ASN","CERTIFICATE","ATTACK_TECHNIQUE","ORGANIZATION","COUNTRY","SECTOR","REPORT",
]);

export const canonicalEvidenceDraftSchema = z.object({
  recordKind: canonicalRecordKindSchema,
  canonicalKey: z.string().min(1).max(1_024),
  entities: z.array(z.object({
    kind: canonicalEntityKindSchema,
    key: z.string().min(1).max(1_024),
    label: z.string().min(1).max(1_024).optional(),
  })).max(256).default([]),
  facts: z.array(z.object({
    predicate: z.string().min(1).max(256),
    value: z.unknown(),
  })).max(512).default([]),
  references: z.array(z.string().url()).max(64).default([]),
});
export type CanonicalEvidenceDraft = z.infer<typeof canonicalEvidenceDraftSchema>;

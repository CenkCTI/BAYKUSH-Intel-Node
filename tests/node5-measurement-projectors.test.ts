import { describe, expect, it } from "vitest";
import { getMeasurementRegistration } from "../src/measurement/registry.js";
import { cisaIcsCsafMeasurementProjector } from "../src/measurement/sources/cisa-ics-csaf.js";
import { feodoTrackerMeasurementProjector } from "../src/measurement/sources/feodo-tracker.js";
import { githubReviewedAdvisoryMeasurementProjector } from "../src/measurement/sources/github-reviewed-advisory.js";
import { measurementSourceProjectors } from "../src/measurement/sources/registry.js";
import { sslblCertificateMeasurementProjector } from "../src/measurement/sources/sslbl-certificate.js";
import { admissionPolicyRegistry } from "../src/sources/admission/registry.js";

const base = {
  id: "canonical-1",
  rawRecordId: "raw-1",
  sourceDefinitionId: "source-1",
  sourceKey: "TEST",
  sourceRecordId: "record-1",
  recordKind: "UNKNOWN",
  canonicalKey: "example:1",
  receivedAt: "2026-08-14T05:00:00.000Z",
  publishedAt: null,
  effectiveAt: null,
  upstreamUpdatedAt: null,
  entities: [],
  facts: [],
  normalizedSha256: "a".repeat(64),
  sourceRevisionNumber: 1,
  trigger: "SCHEDULED",
  purpose: "LIVE_INCREMENTAL",
};

const node5MeasurementKeys = [
  "ioc.feodo_tracker.new_records_observed",
  "ioc.sslbl.certificate_listings_observed",
  "vulnerability.github_advisory.publications",
  "vulnerability.github_advisory.updates_observed",
  "vulnerability.cisa_ics.advisory_publications",
  "vulnerability.cisa_ics.advisory_updates_observed",
] as const;

const node5PermissionMatrix = {
  FEODO_TRACKER: true,
  SSLBL_CERTIFICATE: true,
  GITHUB_ADVISORY_REVIEWED: true,
  CISA_ICS_CSAF: true,
  MITRE_ATTACK_ENTERPRISE: false,
  JVN_IPEDIA: false,
  CERT_EU_SECURITY_ADVISORY: false,
  SIEMENS_PRODUCTCERT_CSAF: false,
} as const;

describe("NODE-5 measurement contracts and projectors", () => {
  it("registers only the measurement-admitted NODE-5 source projectors", () => {
    for (const [sourceKey, allowed] of Object.entries(node5PermissionMatrix)) {
      expect(admissionPolicyRegistry.get(sourceKey)?.measurementProjectionAllowed, sourceKey).toBe(allowed);
      expect(measurementSourceProjectors.has(sourceKey), sourceKey).toBe(allowed);
    }
  });

  it("registers bounded public contracts with explicit non-attack semantics", () => {
    for (const measurementKey of node5MeasurementKeys) {
      const registration = getMeasurementRegistration(measurementKey);
      expect(registration, measurementKey).not.toBeNull();
      expect(registration?.definition.visibility).toBe("PUBLIC");
      expect(registration?.definition.doesNotRepresent.toLowerCase()).toContain("attack");
    }
  });

  it("counts only first live Feodo identities on Node observation time", () => {
    const input = {
      ...base,
      sourceKey: "FEODO_TRACKER",
      sourceRecordId: "c2:fixture",
      recordKind: "IOC_REPORT",
      canonicalKey: "ioc:feodo-c2:fixture",
      entities: [{ kind: "IP", key: "203.0.113.10" }],
      facts: [
        { predicate: "feodo.endpoint_identity", value: "endpoint-fixture" },
        { predicate: "feodo.malware_label", value: "Emotet" },
        { predicate: "feodo.country", value: "DE" },
      ],
    };
    const fact = feodoTrackerMeasurementProjector.projectCanonical(input, "ioc.feodo_tracker.new_records_observed")[0];
    expect(fact?.eventTime).toBe(base.receivedAt);
    expect(fact?.entityKey).toBe("203.0.113.10");
    expect(fact?.dimensions).toMatchObject({ FEODO_MALWARE_LABEL: "Emotet", FEODO_COUNTRY: "DE" });
    expect(feodoTrackerMeasurementProjector.projectCanonical({ ...input, sourceRevisionNumber: 2 }, "ioc.feodo_tracker.new_records_observed")).toEqual([]);
    expect(feodoTrackerMeasurementProjector.projectCanonical({ ...input, trigger: "BOOTSTRAP", purpose: "INITIAL_BOOTSTRAP" }, "ioc.feodo_tracker.new_records_observed")).toEqual([]);
  });

  it("counts only first live SSLBL certificate identities", () => {
    const input = {
      ...base,
      sourceKey: "SSLBL_CERTIFICATE",
      sourceRecordId: "sha1:fixture",
      recordKind: "IOC_REPORT",
      canonicalKey: "ioc:sslbl-certificate:sha1:fixture",
      entities: [{ kind: "CERTIFICATE", key: "sha1:0123456789abcdef0123456789abcdef01234567" }],
      facts: [{ predicate: "sslbl.certificate_sha1", value: "0123456789abcdef0123456789abcdef01234567" }],
    };
    const fact = sslblCertificateMeasurementProjector.projectCanonical(input, "ioc.sslbl.certificate_listings_observed")[0];
    expect(fact?.eventTime).toBe(base.receivedAt);
    expect(fact?.entityKey).toBe("sha1:0123456789abcdef0123456789abcdef01234567");
    expect(sslblCertificateMeasurementProjector.projectCanonical({ ...input, trigger: "BOOTSTRAP", purpose: "INITIAL_BOOTSTRAP" }, "ioc.sslbl.certificate_listings_observed")).toEqual([]);
  });

  it("keeps GitHub advisory publication time separate from live revision observation time", () => {
    const input = {
      ...base,
      sourceKey: "GITHUB_ADVISORY_REVIEWED",
      sourceRecordId: "GHSA-aaaa-bbbb-cccc",
      recordKind: "SECURITY_ADVISORY",
      canonicalKey: "security-advisory:ghsa:ghsa-aaaa-bbbb-cccc",
      publishedAt: "2026-08-13T10:00:00.000Z",
      upstreamUpdatedAt: "2026-08-14T04:00:00.000Z",
      sourceRevisionNumber: 2,
      facts: [
        { predicate: "github_advisory.ghsa_id", value: "GHSA-aaaa-bbbb-cccc" },
        { predicate: "github_advisory.severity", value: "high" },
      ],
    };
    const publication = githubReviewedAdvisoryMeasurementProjector.projectCanonical(input, "vulnerability.github_advisory.publications")[0];
    const update = githubReviewedAdvisoryMeasurementProjector.projectCanonical(input, "vulnerability.github_advisory.updates_observed")[0];
    expect(publication?.eventTime).toBe("2026-08-13T10:00:00.000Z");
    expect(update?.eventTime).toBe(base.receivedAt);
    expect(update?.dimensions.GITHUB_ADVISORY_SEVERITY).toBe("high");
    expect(githubReviewedAdvisoryMeasurementProjector.projectCanonical({ ...input, trigger: "BOOTSTRAP", purpose: "INITIAL_BOOTSTRAP" }, "vulnerability.github_advisory.updates_observed")).toEqual([]);
  });

  it("keeps CISA ICS publication time separate from live retained revisions", () => {
    const input = {
      ...base,
      sourceKey: "CISA_ICS_CSAF",
      sourceRecordId: "ICSA-26-001-01",
      recordKind: "SECURITY_ADVISORY",
      canonicalKey: "security-advisory:cisa-ics:icsa-26-001-01",
      publishedAt: "2026-08-12T08:00:00.000Z",
      upstreamUpdatedAt: "2026-08-14T03:00:00.000Z",
      sourceRevisionNumber: 2,
      facts: [
        { predicate: "cisa_ics.advisory_id", value: "ICSA-26-001-01" },
        { predicate: "cisa_ics.publisher", value: "CISA" },
      ],
    };
    const publication = cisaIcsCsafMeasurementProjector.projectCanonical(input, "vulnerability.cisa_ics.advisory_publications")[0];
    const update = cisaIcsCsafMeasurementProjector.projectCanonical(input, "vulnerability.cisa_ics.advisory_updates_observed")[0];
    expect(publication?.eventTime).toBe("2026-08-12T08:00:00.000Z");
    expect(update?.eventTime).toBe(base.receivedAt);
    expect(update?.dimensions.CISA_ICS_PUBLISHER).toBe("CISA");
    expect(cisaIcsCsafMeasurementProjector.projectCanonical({ ...input, trigger: "RECOVERY", purpose: "LIVE_INCREMENTAL" }, "vulnerability.cisa_ics.advisory_updates_observed")).toEqual([]);
  });
});

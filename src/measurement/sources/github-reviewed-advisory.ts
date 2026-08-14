import type { MeasurementSourceProjector } from "../projection/types.js";
import {
  acquisitionBasis,
  factMap,
  liveObservationAllowed,
  makeCandidate,
  projectDefaultEntityObservations,
  stringFact,
} from "../projection/utils.js";

export const githubReviewedAdvisoryMeasurementProjector: MeasurementSourceProjector = {
  sourceKey: "GITHUB_ADVISORY_REVIEWED",
  projectCanonical(input, measurementKey) {
    const facts = factMap(input.facts);
    const ghsaId = stringFact(facts, "github_advisory.ghsa_id");
    if (!ghsaId) return [];

    const dimensions = {
      GITHUB_ADVISORY_SEVERITY: stringFact(facts, "github_advisory.severity"),
    };
    const basis = acquisitionBasis(input.trigger, input.purpose);

    if (measurementKey === "vulnerability.github_advisory.publications") {
      if (!input.publishedAt) return [];
      return [makeCandidate({
        measurementKey,
        identity: { ghsaId },
        factKind: "EVENT",
        eventTime: input.publishedAt,
        eventDate: null,
        timePrecision: "INSTANT",
        numericValue: 1,
        entityKey: `ghsa:${ghsaId.toUpperCase()}`,
        entityType: "SECURITY_ADVISORY",
        dimensions,
        acquisitionBasis: basis,
        sourceModelVersion: null,
        inputRole: "CANONICAL_RECORD",
        fingerprintMaterial: input.normalizedSha256,
      })];
    }

    if (measurementKey === "vulnerability.github_advisory.updates_observed") {
      if (input.sourceRevisionNumber <= 1 || !liveObservationAllowed(input)) return [];
      return [makeCandidate({
        measurementKey,
        identity: { ghsaId, rawRecordId: input.rawRecordId },
        factKind: "OBSERVATION",
        eventTime: input.receivedAt,
        eventDate: null,
        timePrecision: "INSTANT",
        numericValue: 1,
        entityKey: `ghsa:${ghsaId.toUpperCase()}`,
        entityType: "SECURITY_ADVISORY",
        dimensions,
        acquisitionBasis: basis,
        sourceModelVersion: null,
        inputRole: "CANONICAL_RECORD",
        fingerprintMaterial: input.normalizedSha256,
      })];
    }

    return [];
  },
  projectRaw() {
    return [];
  },
  projectEntityObservations: projectDefaultEntityObservations,
};

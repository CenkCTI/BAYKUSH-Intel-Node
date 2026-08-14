import type { MeasurementSourceProjector } from "../projection/types.js";
import {
  acquisitionBasis,
  factMap,
  liveObservationAllowed,
  makeCandidate,
  projectDefaultEntityObservations,
  stringFact,
} from "../projection/utils.js";

export const cisaIcsCsafMeasurementProjector: MeasurementSourceProjector = {
  sourceKey: "CISA_ICS_CSAF",
  projectCanonical(input, measurementKey) {
    const facts = factMap(input.facts);
    const advisoryId = stringFact(facts, "cisa_ics.advisory_id");
    if (!advisoryId) return [];

    const dimensions = {
      CISA_ICS_PUBLISHER: stringFact(facts, "cisa_ics.publisher"),
    };
    const basis = acquisitionBasis(input.trigger, input.purpose);

    if (measurementKey === "vulnerability.cisa_ics.advisory_publications") {
      if (!input.publishedAt) return [];
      return [makeCandidate({
        measurementKey,
        identity: { advisoryId },
        factKind: "EVENT",
        eventTime: input.publishedAt,
        eventDate: null,
        timePrecision: "INSTANT",
        numericValue: 1,
        entityKey: `cisa-ics:${advisoryId.toUpperCase()}`,
        entityType: "SECURITY_ADVISORY",
        dimensions,
        acquisitionBasis: basis,
        sourceModelVersion: null,
        inputRole: "CANONICAL_RECORD",
        fingerprintMaterial: input.normalizedSha256,
      })];
    }

    if (measurementKey === "vulnerability.cisa_ics.advisory_updates_observed") {
      if (input.sourceRevisionNumber <= 1 || !liveObservationAllowed(input)) return [];
      return [makeCandidate({
        measurementKey,
        identity: { advisoryId, rawRecordId: input.rawRecordId },
        factKind: "OBSERVATION",
        eventTime: input.receivedAt,
        eventDate: null,
        timePrecision: "INSTANT",
        numericValue: 1,
        entityKey: `cisa-ics:${advisoryId.toUpperCase()}`,
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

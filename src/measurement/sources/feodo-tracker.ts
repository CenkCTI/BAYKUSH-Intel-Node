import type { MeasurementSourceProjector } from "../projection/types.js";
import {
  acquisitionBasis,
  canonicalEntities,
  factMap,
  liveObservationAllowed,
  makeCandidate,
  projectDefaultEntityObservations,
  stringFact,
} from "../projection/utils.js";

export const feodoTrackerMeasurementProjector: MeasurementSourceProjector = {
  sourceKey: "FEODO_TRACKER",
  projectCanonical(input, measurementKey) {
    if (measurementKey !== "ioc.feodo_tracker.new_records_observed") return [];
    if (input.sourceRevisionNumber !== 1 || !liveObservationAllowed(input)) return [];

    const facts = factMap(input.facts);
    const endpointIdentity = stringFact(facts, "feodo.endpoint_identity");
    if (!endpointIdentity) return [];

    const ip = canonicalEntities(input.entities).find((entity) => entity.kind === "IP") ?? null;
    return [makeCandidate({
      measurementKey,
      identity: { endpointIdentity },
      factKind: "OBSERVATION",
      eventTime: input.receivedAt,
      eventDate: null,
      timePrecision: "INSTANT",
      numericValue: 1,
      entityKey: ip?.key ?? input.canonicalKey,
      entityType: ip?.kind ?? "IOC_REPORT",
      dimensions: {
        FEODO_MALWARE_LABEL: stringFact(facts, "feodo.malware_label"),
        FEODO_COUNTRY: stringFact(facts, "feodo.country"),
      },
      acquisitionBasis: acquisitionBasis(input.trigger, input.purpose),
      sourceModelVersion: null,
      inputRole: "CANONICAL_RECORD",
      fingerprintMaterial: input.normalizedSha256,
    })];
  },
  projectRaw() {
    return [];
  },
  projectEntityObservations: projectDefaultEntityObservations,
};

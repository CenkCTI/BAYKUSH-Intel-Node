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

export const sslblCertificateMeasurementProjector: MeasurementSourceProjector = {
  sourceKey: "SSLBL_CERTIFICATE",
  projectCanonical(input, measurementKey) {
    if (measurementKey !== "ioc.sslbl.certificate_listings_observed") return [];
    if (input.sourceRevisionNumber !== 1 || !liveObservationAllowed(input)) return [];

    const facts = factMap(input.facts);
    const sha1 = stringFact(facts, "sslbl.certificate_sha1");
    if (!sha1) return [];

    const certificate = canonicalEntities(input.entities).find((entity) => entity.kind === "CERTIFICATE") ?? null;
    return [makeCandidate({
      measurementKey,
      identity: { sha1 },
      factKind: "OBSERVATION",
      eventTime: input.receivedAt,
      eventDate: null,
      timePrecision: "INSTANT",
      numericValue: 1,
      entityKey: certificate?.key ?? `sha1:${sha1}`,
      entityType: certificate?.kind ?? "CERTIFICATE",
      dimensions: {},
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

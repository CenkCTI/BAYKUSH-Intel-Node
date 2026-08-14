import type { MeasurementSourceProjector } from "../projection/types.js";
import { cisaIcsCsafMeasurementProjector } from "./cisa-ics-csaf.js";
import { cisaKevMeasurementProjector } from "./cisa-kev.js";
import { feodoTrackerMeasurementProjector } from "./feodo-tracker.js";
import { firstEpssMeasurementProjector } from "./first-epss.js";
import { githubReviewedAdvisoryMeasurementProjector } from "./github-reviewed-advisory.js";
import { malwareBazaarMeasurementProjector } from "./malwarebazaar.js";
import { nvdMeasurementProjector } from "./nvd-cve.js";
import { sslblCertificateMeasurementProjector } from "./sslbl-certificate.js";
import { testSyntheticMeasurementProjector } from "./test-synthetic.js";
import { threatFoxMeasurementProjector } from "./threatfox.js";

const projectors: readonly MeasurementSourceProjector[] = [
  testSyntheticMeasurementProjector,
  cisaKevMeasurementProjector,
  nvdMeasurementProjector,
  firstEpssMeasurementProjector,
  threatFoxMeasurementProjector,
  malwareBazaarMeasurementProjector,
  feodoTrackerMeasurementProjector,
  sslblCertificateMeasurementProjector,
  githubReviewedAdvisoryMeasurementProjector,
  cisaIcsCsafMeasurementProjector,
];

export const measurementSourceProjectors = new Map<string, MeasurementSourceProjector>(
  projectors.map((projector) => [projector.sourceKey, projector]),
);

if (measurementSourceProjectors.size !== projectors.length) {
  throw new Error("Duplicate NODE-3 measurement source projector key");
}

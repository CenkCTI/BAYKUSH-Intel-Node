import { sourceDefinitionSchema, type SourceDefinition } from "../../contracts/source.js";

export const RIPE_RIS_LIVE_URL = "wss://ris-live.ripe.net/v1/ws/?client=baykush-intelligence-node";

export const ripeRisSourceDefinition: SourceDefinition = sourceDefinitionSchema.parse({
  sourceKey: "RIPE_RIS_BGP",
  displayName: "RIPE RIS BGP",
  providerName: "RIPE NCC",
  upstreamOriginKey: "RIPE_RIS",
  sourceClass: "ROUTING_TELEMETRY",
  observationBasis: "OBSERVED",
  authorityType: "ROUTING_OBSERVATION_PROVIDER",
  collectionMode: "STREAM",
  defaultPollIntervalSeconds: null,
  minimumPollIntervalSeconds: null,
  supportsHistoricalRetrieval: true,
  recoveryStrategy: "HISTORICAL_QUERY",
  historicalMaxWindowSeconds: 7 * 24 * 60 * 60,
  requiresAuth: false,
  authRequirement: "NONE",
  credentialKind: null,
  adapterVersion: "ripe-ris-live-v1",
  semanticContractVersion: "ripe-ris-routing-semantics-v1",
  licenseClass: "RIPE_RIS_TERMS",
  commercialUseStatus: "RESTRICTED",
  redistributionStatus: "RESTRICTED",
  attributionRequirement: "Retain RIPE NCC / Routing Information Service attribution and do not imply RIPE NCC endorsement.",
  termsReference: "https://www.ripe.net/analyse/internet-measurements/routing-information-service-ris/",
  semanticBoundary: {
    represents: "BGP routing messages observed by the configured RIPE RIS route-collector population during the stated interval.",
    doesNotRepresent: "Global Internet routing totality, cyberattack count, Internet outage count, BGP hijack verdict, malicious routing, attacker origin, victim identity, business impact, risk, severity, or global cyber threat level.",
  },
  enabledByDefault: false,
});

export const ripeRisSubscription = Object.freeze({
  type: "UPDATE",
  socketOptions: Object.freeze({ includeRaw: false, acknowledge: true }),
});

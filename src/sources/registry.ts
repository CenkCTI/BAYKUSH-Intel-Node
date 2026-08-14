import { config } from "../config.js";
import { assertAdapterContract, type SourceAdapter } from "../contracts/source.js";
import { createCisaKevAdapter } from "./cisa-kev.js";
import { createFeodoTrackerAdapter } from "./feodo-tracker.js";
import { createFirstEpssAdapter } from "./first-epss.js";
import { createMalwareBazaarAdapter } from "./malwarebazaar.js";
import { createNvdCveAdapterV2 } from "./nvd-cve-normalization-v2.js";
import { createTestSyntheticAdapter } from "./test-synthetic.js";
import { createThreatFoxAdapter } from "./threatfox.js";

const adapters = [
  createTestSyntheticAdapter({
    recordsPerRun: config.syntheticRecordsPerRun,
    pageSize: config.syntheticPageSize,
  }),
  createCisaKevAdapter(),
  createNvdCveAdapterV2(config.nvdApiKey === undefined ? {} : { apiKey: config.nvdApiKey }),
  createFirstEpssAdapter(),
  createThreatFoxAdapter(config.threatFoxAuthKey === undefined ? {} : { authKey: config.threatFoxAuthKey }),
  createMalwareBazaarAdapter(config.malwareBazaarAuthKey === undefined ? {} : { authKey: config.malwareBazaarAuthKey }),
  createFeodoTrackerAdapter(),
];

for (const adapter of adapters) assertAdapterContract(adapter);

export const adapterRegistry = new Map<string, SourceAdapter>(
  adapters.map((adapter) => [adapter.definition.sourceKey, adapter]),
);

export const registeredSourceKeys = Object.freeze([...adapterRegistry.keys()]);

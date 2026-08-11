import { config } from "../config.js";
import { adapterRegistry, registeredSourceKeys } from "../sources/registry.js";
import { enqueueDueRuns, setSourceEnabled } from "./repository.js";
import { syncSourceDefinitions } from "./source-sync.js";

let sourceDefinitionsSynchronized = false;
let developmentSourceConfigured = false;

export async function schedulerTick(): Promise<number> {
  if (!sourceDefinitionsSynchronized) {
    await syncSourceDefinitions([...adapterRegistry.values()]);
    sourceDefinitionsSynchronized = true;
  }
  if (config.enableTestSynthetic && !developmentSourceConfigured) {
    await setSourceEnabled("TEST_SYNTHETIC", true);
    developmentSourceConfigured = true;
  }
  return enqueueDueRuns(registeredSourceKeys, 10);
}

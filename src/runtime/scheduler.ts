import { config } from "../config.js";
import { registeredSourceKeys } from "../sources/registry.js";
import { enqueueDueRuns, setSourceEnabled } from "./repository.js";

let developmentSourceConfigured = false;

export async function schedulerTick(): Promise<number> {
  if (config.enableTestSynthetic && !developmentSourceConfigured) {
    await setSourceEnabled("TEST_SYNTHETIC", true);
    developmentSourceConfigured = true;
  }
  return enqueueDueRuns(registeredSourceKeys, 10);
}

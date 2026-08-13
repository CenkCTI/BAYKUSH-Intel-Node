import { config } from "../config.js";
import type { SourceAdapter } from "../contracts/source.js";
import { assertAdapterContract } from "../contracts/source.js";
import { adapterRegistry } from "./registry.js";
import { withReplayableSnapshotChunking } from "./snapshot-chunk-adapter.js";

const prepared = new Set<string>();

function prepareAdapter(adapter: SourceAdapter): SourceAdapter {
  const declaredBound = adapter.maxRecordsPerWorkUnit ?? config.maxRecordsPerWorkUnit;
  if (declaredBound > config.globalMaxRecordsPerWorkUnit) {
    if (adapter.definition.collectionMode !== "SNAPSHOT") {
      throw new Error(`Source ${adapter.definition.sourceKey} exceeds the global record bound without replayable SNAPSHOT semantics`);
    }
    return withReplayableSnapshotChunking(adapter, config.globalMaxRecordsPerWorkUnit);
  }
  return adapter;
}

export function registerNode5Adapter(adapter: SourceAdapter): void {
  assertAdapterContract(adapter);
  if (adapterRegistry.has(adapter.definition.sourceKey) && !prepared.has(adapter.definition.sourceKey)) {
    throw new Error(`NODE-5 adapter attempted to replace an existing source: ${adapter.definition.sourceKey}`);
  }
  adapterRegistry.set(adapter.definition.sourceKey, prepareAdapter(adapter));
  prepared.add(adapter.definition.sourceKey);
}

export function prepareRegisteredNode5Adapters(): void {
  for (const [sourceKey, adapter] of [...adapterRegistry.entries()]) {
    if (prepared.has(sourceKey)) continue;
    adapterRegistry.set(sourceKey, prepareAdapter(adapter));
    prepared.add(sourceKey);
  }
}

prepareRegisteredNode5Adapters();

export { adapterRegistry };

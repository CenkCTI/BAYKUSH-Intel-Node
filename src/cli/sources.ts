import { pool } from "../db/pool.js";
import { setSourceEnabled } from "../runtime/repository.js";
import { getSourceStatus, listSourceStates, syncSourceDefinitions } from "../runtime/source-sync.js";
import { adapterRegistry } from "../sources/registry.js";

function usage(): never {
  console.error("Usage: npm run sources -- <list|status|enable|disable> [SOURCE_KEY]");
  process.exitCode = 2;
  throw new Error("Invalid source CLI arguments");
}

async function main(): Promise<void> {
  await syncSourceDefinitions([...adapterRegistry.values()]);
  const [command, sourceKey] = process.argv.slice(2);
  if (!command || !["list", "status", "enable", "disable"].includes(command)) usage();

  if (command === "list") {
    const states = await listSourceStates();
    console.table(states);
    return;
  }

  if (!sourceKey) usage();
  if (!adapterRegistry.has(sourceKey)) throw new Error(`Source is not registered in this Node build: ${sourceKey}`);

  if (command === "status") {
    const status = await getSourceStatus(sourceKey);
    if (!status) throw new Error(`Source state not found: ${sourceKey}`);
    console.dir(status, { depth: null });
    return;
  }

  await setSourceEnabled(sourceKey, command === "enable");
  const states = await listSourceStates();
  const selected = states.find((state) => state.sourceKey === sourceKey);
  console.log(`${sourceKey} ${selected?.enabled ? "enabled" : "disabled"}`);
}

try {
  await main();
} finally {
  await pool.end();
}

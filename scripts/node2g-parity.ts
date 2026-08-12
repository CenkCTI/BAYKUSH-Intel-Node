import { readFile } from "node:fs/promises";
import { compareParitySnapshots, type ManualParityClassification } from "../src/node2g/parity.js";

const [, , nodePath, citemPath, classificationsPath] = process.argv;
if (!nodePath || !citemPath) {
  console.error("Usage: npm run node2g:parity -- <node-snapshot.json> <citem-snapshot.json> [manual-classifications.json]");
  process.exit(2);
}

const nodeSnapshot = JSON.parse(await readFile(nodePath, "utf8")) as unknown;
const citemSnapshot = JSON.parse(await readFile(citemPath, "utf8")) as unknown;
let manualClassifications: ManualParityClassification[] = [];
if (classificationsPath) {
  const parsed = JSON.parse(await readFile(classificationsPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("manual classifications file must contain a JSON array");
  manualClassifications = parsed as ManualParityClassification[];
}

const comparison = compareParitySnapshots(nodeSnapshot, citemSnapshot, manualClassifications);
console.log(JSON.stringify(comparison, null, 2));
process.exitCode = comparison.accepted ? 0 : 1;

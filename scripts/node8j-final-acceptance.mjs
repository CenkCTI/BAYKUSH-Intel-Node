#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { aggregateAcceptance, readJson } from "./node8j-evidence.mjs";
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const i=arg.indexOf("="); if (!arg.startsWith("--") || i<3) throw new Error(`invalid argument: ${arg}`); return [arg.slice(2,i),arg.slice(i+1)]; }));
if (!args["expected-image"]) throw new Error("--expected-image is required");
const one = (name) => args[name] ? readJson(args[name]) : undefined;
const manual = args["manual-dir"] ? readdirSync(args["manual-dir"]).filter((f) => f.endsWith(".json")).sort().map((f) => readJson(join(args["manual-dir"],f))) : [];
const evidence = aggregateAcceptance({ expectedImage:args["expected-image"], release:one("release"), backup:one("backup"), restore:one("restore"), operations:one("operations"), resilience:one("resilience"), preflight:one("preflight"), citem:one("citem"), manual });
process.stdout.write(`${JSON.stringify(evidence,null,2)}\n`);
if (evidence.result === "FAILED") process.exitCode=1;
else if (evidence.result === "MANUAL_PENDING") process.exitCode=2;

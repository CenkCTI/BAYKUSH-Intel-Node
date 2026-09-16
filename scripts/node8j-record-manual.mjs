#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createManualEvidence } from "./node8j-evidence.mjs";
const required = (name) => { const value=process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const references = (process.env.NODE8J_REFERENCE_FILES ?? "").split(":").filter(Boolean).map((path) => ({ name:basename(path), sha256:createHash("sha256").update(readFileSync(path)).digest("hex") }));
const evidence=createManualEvidence({ scenarioId:required("NODE8J_SCENARIO"), result:required("NODE8J_RESULT"), hostId:required("NODE8J_HOST_ID"), releaseImage:required("NODE8J_RELEASE_IMAGE"), operatorNote:process.env.NODE8J_OPERATOR_NOTE ?? "", references });
const dir=required("NODE8J_EVIDENCE_DIR");
const stamp=evidence.observedAt.replace(/[-:.]/g,"");
const target=join(dir,`${evidence.scenarioId}-${stamp}.json`), temporary=`${target}.tmp`;
writeFileSync(temporary,`${JSON.stringify(evidence,null,2)}\n`,{mode:0o600}); chmodSync(temporary,0o600); renameSync(temporary,target);
process.stdout.write(`manual-acceptance: ${evidence.result} ${evidence.scenarioId} ${target}\n`);

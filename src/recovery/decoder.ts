import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { config } from "../config.js";
import type { RoutingObservation } from "../stream/contracts.js";
import {
  DECODER_SUMMARY_CONTRACT_VERSION,
  decoderRecordToRoutingObservation,
  mrtDecoderRecordSchema,
  mrtDecoderSummarySchema,
  type MrtDecoderRecord,
  type MrtDecoderSummary,
} from "./contracts.js";
import { RecoveryFailure } from "./errors.js";
import {
  DECODER_CONTRACT_VERSION,
  DECODER_NAME,
  DECODER_UPSTREAM_COMMIT,
  DECODER_UPSTREAM_TAG,
  DECODER_VERSION,
} from "./policy.js";

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function recoveryDecoderBinarySha256(): Promise<string> {
  return sha256File(config.recoveryDecoderPath);
}

export interface DecoderRunResult {
  decoderName: string;
  decoderVersion: string;
  decoderUpstreamTag: string;
  decoderUpstreamCommit: string;
  decoderBinarySha256: string;
  decoderContractVersion: string;
  arguments: string[];
  recordsRead: number;
  updatesDecoded: number;
  stateChangeRecords: number;
  recordsIgnored: number;
  recordsRejected: number;
  outputSha256: string;
  exitCode: number;
}

export async function runMrtDecoder(input: {
  artifactPath: string;
  artifactSha256: string;
  rrc: string;
  onObservation: (observation: RoutingObservation, record: MrtDecoderRecord) => void | Promise<void>;
}): Promise<DecoderRunResult> {
  const binarySha = await recoveryDecoderBinarySha256();
  const child = spawn(config.recoveryDecoderPath, [input.artifactPath], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
  if (!child.stdout || !child.stderr) throw new RecoveryFailure("DECODER_EXIT_NONZERO", "Decoder stdio unavailable");

  let timedOut = false;
  let stderr = "";
  let outputBytes = 0;
  let outputLines = 0;
  let projectedUpdates = 0;
  let summary: MrtDecoderSummary | null = null;
  const outputHash = createHash("sha256");

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 65_536) stderr += chunk.slice(0, 65_536 - stderr.length);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, config.recoveryDecoderTimeoutMs);
  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });

  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      outputBytes += Buffer.byteLength(line) + 1;
      if (outputBytes > config.recoveryDecoderMaxOutputBytes) {
        child.kill("SIGKILL");
        throw new RecoveryFailure("DECODER_OUTPUT_LIMIT", "Decoder output byte limit exceeded");
      }
      outputLines += 1;
      if (outputLines > config.recoveryDecoderMaxRecords + 1) {
        child.kill("SIGKILL");
        throw new RecoveryFailure("DECODER_OUTPUT_LIMIT", "Decoder output line limit exceeded");
      }
      outputHash.update(line);
      outputHash.update("\n");

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        child.kill("SIGKILL");
        throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder emitted non-JSON output", error);
      }
      const schemaVersion = typeof parsed === "object" && parsed !== null && "schemaVersion" in parsed
        ? (parsed as { schemaVersion?: unknown }).schemaVersion
        : undefined;
      if (schemaVersion === DECODER_SUMMARY_CONTRACT_VERSION) {
        if (summary !== null) {
          child.kill("SIGKILL");
          throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder emitted multiple summary records");
        }
        try {
          summary = mrtDecoderSummarySchema.parse(parsed);
        } catch (error) {
          child.kill("SIGKILL");
          throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder emitted invalid summary provenance", error);
        }
        continue;
      }
      if (summary !== null) {
        child.kill("SIGKILL");
        throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder emitted records after its final summary");
      }
      let record: MrtDecoderRecord;
      try {
        record = mrtDecoderRecordSchema.parse(parsed);
      } catch (error) {
        child.kill("SIGKILL");
        throw new RecoveryFailure(
          "DECODER_OUTPUT_INVALID",
          "Decoder emitted invalid NODE6_2_MRT_DECODER_V1 JSONL",
          error,
        );
      }
      projectedUpdates += 1;
      const observation = decoderRecordToRoutingObservation({
        record,
        rrc: input.rrc,
        artifactSha256: input.artifactSha256,
        nodeReceivedAt: new Date().toISOString(),
      });
      await input.onObservation(observation, record);
    }

    const exitCode = await exitPromise;
    if (timedOut) throw new RecoveryFailure("DECODER_TIMEOUT", "Pinned MRT decoder exceeded execution timeout");
    if (exitCode !== 0) {
      throw new RecoveryFailure(
        "DECODER_EXIT_NONZERO",
        `Pinned MRT decoder exited ${exitCode}: ${stderr.trim().slice(0, 2048)}`,
      );
    }
    if (summary === null) throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder did not emit final summary provenance");
    if (summary.updatesDecoded !== projectedUpdates) {
      throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder summary/update count mismatch");
    }
    if (summary.recordsRead > config.recoveryDecoderMaxRecords) {
      throw new RecoveryFailure("DECODER_OUTPUT_LIMIT", "Decoder physical record count exceeded configured limit");
    }
    if (summary.recordsRejected !== 0) {
      throw new RecoveryFailure("DECODER_CORRUPT_RECORD", "Decoder reported rejected physical MRT records");
    }
    if (summary.stateChangeRecords > summary.ignoredValidRecords) {
      throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder state-change count exceeds ignored-valid count");
    }
    if (summary.updatesDecoded + summary.ignoredValidRecords > summary.recordsRead) {
      throw new RecoveryFailure("DECODER_OUTPUT_INVALID", "Decoder summary counters exceed physical records read");
    }

    return {
      decoderName: DECODER_NAME,
      decoderVersion: DECODER_VERSION,
      decoderUpstreamTag: DECODER_UPSTREAM_TAG,
      decoderUpstreamCommit: DECODER_UPSTREAM_COMMIT,
      decoderBinarySha256: binarySha,
      decoderContractVersion: DECODER_CONTRACT_VERSION,
      arguments: ["<local-staged-artifact>"],
      recordsRead: summary.recordsRead,
      updatesDecoded: summary.updatesDecoded,
      stateChangeRecords: summary.stateChangeRecords,
      recordsIgnored: summary.ignoredValidRecords,
      recordsRejected: summary.recordsRejected,
      outputSha256: outputHash.digest("hex"),
      exitCode,
    };
  } catch (error) {
    if (!child.killed) child.kill("SIGKILL");
    await exitPromise.catch(() => -1);
    if (error instanceof RecoveryFailure) throw error;
    throw new RecoveryFailure("DECODER_EXIT_NONZERO", "Pinned MRT decoder execution failed", error);
  } finally {
    clearTimeout(timer);
  }
}

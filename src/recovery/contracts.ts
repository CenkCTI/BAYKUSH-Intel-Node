import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { RoutingObservation } from "../stream/contracts.js";
import { DECODER_CONTRACT_VERSION } from "./policy.js";

export const DECODER_SUMMARY_CONTRACT_VERSION = "NODE6_2_MRT_DECODER_SUMMARY_V1" as const;

const asnSchema = z.number().int().min(0).max(4_294_967_295);
const pathSegmentSchema = z.object({
  kind: z.enum(["AS_SEQUENCE", "AS_SET", "CONFED_SEQUENCE", "CONFED_SET"]),
  asns: z.array(asnSchema).max(512),
}).strict();

export const mrtDecoderRecordSchema = z.object({
  schemaVersion: z.literal(DECODER_CONTRACT_VERSION),
  recordIndex: z.number().int().nonnegative(),
  recordType: z.literal("BGP4MP"),
  recordSubtype: z.string().min(1).max(64),
  sourceObservedAt: z.string().datetime({ offset: true }),
  peerIp: z.string().min(2).max(128),
  peerAsn: asnSchema,
  announcedPrefixes: z.array(z.string().min(3).max(128)).max(4096),
  withdrawnPrefixes: z.array(z.string().min(3).max(128)).max(4096),
  asPathSegments: z.array(pathSegmentSchema).max(512),
}).strict();
export type MrtDecoderRecord = z.infer<typeof mrtDecoderRecordSchema>;

export const mrtDecoderSummarySchema = z.object({
  schemaVersion: z.literal(DECODER_SUMMARY_CONTRACT_VERSION),
  recordsRead: z.number().int().nonnegative(),
  updatesDecoded: z.number().int().nonnegative(),
  stateChangeRecords: z.number().int().nonnegative(),
  ignoredValidRecords: z.number().int().nonnegative(),
  recordsRejected: z.number().int().nonnegative(),
}).strict();
export type MrtDecoderSummary = z.infer<typeof mrtDecoderSummarySchema>;

function canonicalPrefix(input: string): string {
  const [address, lengthText, ...rest] = input.trim().split("/");
  if (!address || !lengthText || rest.length) throw new Error("Invalid CIDR prefix");
  const version = isIP(address);
  if (!version) throw new Error("Invalid CIDR address");
  const length = Number(lengthText);
  const max = version === 4 ? 32 : 128;
  if (!Number.isInteger(length) || length < 0 || length > max) throw new Error("Invalid CIDR prefix length");
  return `${address.toLowerCase()}/${length}`;
}

export function definitiveOriginAsns(segments: MrtDecoderRecord["asPathSegments"]): number[] {
  const last = segments.at(-1);
  if (!last || last.kind !== "AS_SEQUENCE") return [];
  const value = last.asns.at(-1);
  return value === undefined ? [] : [value];
}

export function decoderRecordToRoutingObservation(input: {
  record: MrtDecoderRecord;
  rrc: string;
  artifactSha256: string;
  nodeReceivedAt: string;
}): RoutingObservation {
  if (!/^rrc\d{2}$/.test(input.rrc)) throw new Error("Invalid trusted recovery RRC");
  if (!isIP(input.record.peerIp)) throw new Error("Invalid peer IP from decoder");
  const announcedPrefixes = input.record.announcedPrefixes.map(canonicalPrefix);
  const withdrawnPrefixes = input.record.withdrawnPrefixes.map(canonicalPrefix);
  const identity = {
    upstream: "RIPE_RIS",
    artifactSha256: input.artifactSha256,
    recordIndex: input.record.recordIndex,
    sourceObservedAt: input.record.sourceObservedAt,
    peerAsn: input.record.peerAsn,
    peerIp: input.record.peerIp,
    announcedPrefixes,
    withdrawnPrefixes,
    asPathSegments: input.record.asPathSegments,
  };
  return {
    messageId: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    sourceObservedAt: new Date(input.record.sourceObservedAt).toISOString(),
    nodeReceivedAt: input.nodeReceivedAt,
    rrc: input.rrc,
    peerIp: input.record.peerIp,
    peerAsn: input.record.peerAsn,
    announcedPrefixes,
    withdrawnPrefixes,
    originAsns: definitiveOriginAsns(input.record.asPathSegments),
  };
}

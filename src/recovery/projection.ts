import { isIP } from "node:net";
import type { RoutingMinuteDelta, RoutingObservation } from "../stream/contracts.js";
import { fingerprintRoutingDelta } from "../routing/aggregate.js";

interface MutableMinute {
  updates: number; announcements: number; withdrawals: number; ipv4: number; ipv6: number;
  announced: Set<string>; withdrawn: Set<string>; all: Set<string>; origins: Set<number>; peers: Set<number>;
}
function minuteStart(ms: number): number { return Math.floor(ms / 60_000) * 60_000; }
function createMinute(): MutableMinute { return { updates:0,announcements:0,withdrawals:0,ipv4:0,ipv6:0,announced:new Set(),withdrawn:new Set(),all:new Set(),origins:new Set(),peers:new Set() }; }
function sorted<T extends string | number>(values: Set<T>): T[] { return [...values].sort((a,b)=>String(a).localeCompare(String(b),"en",{numeric:true})); }
function countFamily(prefix: string, minute: MutableMinute): void { const version=isIP(prefix.split("/")[0]??""); if(version===4)minute.ipv4+=1; else if(version===6)minute.ipv6+=1; else throw new Error("Invalid projected prefix family"); }

export class RecoveryProjectionAccumulator {
  readonly #rrc: string; readonly #artifactFrom: number; readonly #artifactTo: number; readonly #targetFrom: number; readonly #targetTo: number;
  readonly #minutes = new Map<number, MutableMinute>();
  constructor(input:{rrc:string;artifactWindowStart:string;artifactWindowEnd:string;targetFrom:string;targetTo:string}) {
    this.#rrc=input.rrc; this.#artifactFrom=Date.parse(input.artifactWindowStart); this.#artifactTo=Date.parse(input.artifactWindowEnd);
    this.#targetFrom=Date.parse(input.targetFrom); this.#targetTo=Date.parse(input.targetTo);
    if(!/^rrc\d{2}$/.test(this.#rrc)||![this.#artifactFrom,this.#artifactTo,this.#targetFrom,this.#targetTo].every(Number.isFinite))throw new Error("Invalid recovery projection bounds");
  }
  accept(observation: RoutingObservation): void {
    if(observation.rrc!==this.#rrc)throw new Error("POPULATION_MISMATCH");
    const observed=Date.parse(observation.sourceObservedAt); if(observed<this.#artifactFrom||observed>=this.#artifactTo)throw new Error("TIMESTAMP_ANOMALY");
    if(observed<this.#targetFrom||observed>=this.#targetTo)return;
    const key=minuteStart(observed); const minute=this.#minutes.get(key)??createMinute(); minute.updates+=1;
    if(observation.peerAsn!==null)minute.peers.add(observation.peerAsn); for(const asn of observation.originAsns)minute.origins.add(asn);
    for(const prefix of observation.announcedPrefixes){minute.announcements+=1;minute.announced.add(prefix);minute.all.add(prefix);countFamily(prefix,minute);}
    for(const prefix of observation.withdrawnPrefixes){minute.withdrawals+=1;minute.withdrawn.add(prefix);minute.all.add(prefix);countFamily(prefix,minute);}
    this.#minutes.set(key,minute);
  }
  finalize(): Array<{delta:RoutingMinuteDelta;fingerprint:string}> {
    const first=Math.max(minuteStart(this.#artifactFrom),minuteStart(this.#targetFrom)); const end=Math.min(this.#artifactTo,this.#targetTo); const output:Array<{delta:RoutingMinuteDelta;fingerprint:string}>=[];
    for(let cursor=first;cursor<end;cursor+=60_000){const m=this.#minutes.get(cursor)??createMinute();const delta:RoutingMinuteDelta={bucketStart:new Date(cursor).toISOString(),bucketEnd:new Date(cursor+60_000).toISOString(),updateMessages:m.updates,announcementPrefixEvents:m.announcements,withdrawalPrefixEvents:m.withdrawals,announcedPrefixes:sorted(m.announced),withdrawnPrefixes:sorted(m.withdrawn),allPrefixes:sorted(m.all),originAsns:sorted(m.origins),peerAsns:sorted(m.peers),rrcs:[this.#rrc],ipv4PrefixEvents:m.ipv4,ipv6PrefixEvents:m.ipv6,rejectedMessages:0};output.push({delta,fingerprint:fingerprintRoutingDelta(delta)});}
    return output;
  }
}

export function recoveryCompleteness(expectedRrcs: readonly string[], projectedRrcs: readonly string[], rejectedRecords = 0): {status:"COMPLETE"|"PARTIAL"|"DEGRADED";availability:"AVAILABLE"|"PARTIAL";missingRrcs:string[]} {
  const expected=[...new Set(expectedRrcs)].sort(); const projected=[...new Set(projectedRrcs)].sort(); const set=new Set(projected); const missing=expected.filter((rrc)=>!set.has(rrc));
  if(rejectedRecords>0)return{status:"DEGRADED",availability:"PARTIAL",missingRrcs:missing};
  if(missing.length>0)return{status:"PARTIAL",availability:"PARTIAL",missingRrcs:missing};
  return{status:"COMPLETE",availability:"AVAILABLE",missingRrcs:[]};
}

export type RoutingAcquisitionSummary = "LIVE_STREAM"|"MRT_RECOVERY"|"MIXED";
export function summarizeAcquisitionBasis(bases: readonly string[]): RoutingAcquisitionSummary {
  const unique=new Set(bases); if(unique.size===1&&unique.has("LIVE_STREAM"))return"LIVE_STREAM"; if(unique.size===1&&unique.has("MRT_RECOVERY"))return"MRT_RECOVERY"; return"MIXED";
}

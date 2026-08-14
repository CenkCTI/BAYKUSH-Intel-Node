import { createHash } from "node:crypto";
import { bucketForInstant } from "../measurement/time.js";
import type { RoutingMinuteDelta, RoutingObservation } from "../stream/contracts.js";

interface MutableMinute {
  start: string; end: string; updates: number; announcements: number; withdrawals: number;
  announced: Set<string>; withdrawn: Set<string>; all: Set<string>; origins: Set<number>; peers: Set<number>; rrcs: Set<string>;
  ipv4: number; ipv6: number; rejected: number;
}

function ipVersion(prefix: string): 4 | 6 { return prefix.includes(":") ? 6 : 4; }
function sortedStrings(values: Set<string>): string[] { return [...values].sort(); }
function sortedNumbers(values: Set<number>): number[] { return [...values].sort((a,b)=>a-b); }

export function aggregateRoutingObservations(observations: readonly RoutingObservation[], rejectedMessages = 0): RoutingMinuteDelta[] {
  const minutes = new Map<string, MutableMinute>();
  for (const observation of observations) {
    const bucket = bucketForInstant(observation.sourceObservedAt, "ONE_MINUTE");
    let minute = minutes.get(bucket.start);
    if (!minute) {
      minute = { start: bucket.start, end: bucket.end, updates: 0, announcements: 0, withdrawals: 0, announced: new Set(), withdrawn: new Set(), all: new Set(), origins: new Set(), peers: new Set(), rrcs: new Set(), ipv4: 0, ipv6: 0, rejected: 0 };
      minutes.set(bucket.start, minute);
    }
    minute.updates += 1; minute.announcements += observation.announcedPrefixes.length; minute.withdrawals += observation.withdrawnPrefixes.length; minute.rrcs.add(observation.rrc);
    if (observation.peerAsn !== null) minute.peers.add(observation.peerAsn);
    for (const origin of observation.originAsns) minute.origins.add(origin);
    for (const prefix of observation.announcedPrefixes) { minute.announced.add(prefix); minute.all.add(prefix); if (ipVersion(prefix)===4) minute.ipv4+=1; else minute.ipv6+=1; }
    for (const prefix of observation.withdrawnPrefixes) { minute.withdrawn.add(prefix); minute.all.add(prefix); if (ipVersion(prefix)===4) minute.ipv4+=1; else minute.ipv6+=1; }
  }
  const ordered = [...minutes.values()].sort((a,b)=>a.start.localeCompare(b.start));
  if (ordered.length && rejectedMessages) ordered[ordered.length - 1]!.rejected += rejectedMessages;
  return ordered.map((minute) => ({
    bucketStart: minute.start, bucketEnd: minute.end, updateMessages: minute.updates,
    announcementPrefixEvents: minute.announcements, withdrawalPrefixEvents: minute.withdrawals,
    announcedPrefixes: sortedStrings(minute.announced), withdrawnPrefixes: sortedStrings(minute.withdrawn), allPrefixes: sortedStrings(minute.all),
    originAsns: sortedNumbers(minute.origins), peerAsns: sortedNumbers(minute.peers), rrcs: sortedStrings(minute.rrcs),
    ipv4PrefixEvents: minute.ipv4, ipv6PrefixEvents: minute.ipv6, rejectedMessages: minute.rejected,
  }));
}

export function fingerprintRoutingDelta(delta: RoutingMinuteDelta): string {
  return createHash("sha256").update(JSON.stringify(delta)).digest("hex");
}

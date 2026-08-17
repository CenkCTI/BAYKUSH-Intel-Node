export interface QueuedStreamMessage { raw: string; receivedAt: string; bytes: number; }

export interface RoutingObservation {
  messageId: string | null;
  sourceObservedAt: string;
  nodeReceivedAt: string;
  rrc: string;
  peerIp: string | null;
  peerAsn: number | null;
  announcedPrefixes: readonly string[];
  withdrawnPrefixes: readonly string[];
  originAsns: readonly number[];
}

export interface RoutingMinuteDelta {
  bucketStart: string;
  bucketEnd: string;
  updateMessages: number;
  announcementPrefixEvents: number;
  withdrawalPrefixEvents: number;
  announcedPrefixes: readonly string[];
  withdrawnPrefixes: readonly string[];
  allPrefixes: readonly string[];
  originAsns: readonly number[];
  peerAsns: readonly number[];
  rrcs: readonly string[];
  ipv4PrefixEvents: number;
  ipv6PrefixEvents: number;
  rejectedMessages: number;
}

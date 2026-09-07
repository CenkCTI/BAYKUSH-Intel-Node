import { BlockList, isIP } from "node:net";

// Keep families separate: node:net BlockList normalizes IPv4 checks through
// IPv4-mapped IPv6 space when both families share one list.
const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();

for (const [subnet, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(subnet, prefix, "ipv4");

for (const [subnet, prefix] of [
  // Only the currently allocated global-unicast space (2000::/3) is eligible.
  // These outer ranges also fail closed for IPv4-compatible/mapped, NAT64,
  // discard-only and other special-purpose forms below 2000::.
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) blockedIpv6.addSubnet(subnet, prefix, "ipv6");

const forbiddenHostnames = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.oraclecloud.com",
]);

export function isForbiddenSourceHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return forbiddenHostnames.has(normalized)
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal");
}

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) return !blockedIpv6.check(address, "ipv6");
  return false;
}

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { canonicalJsonStringify } from "../../runtime/raw-record.js";

const responseSchema = z.object({
  ip: z.string().min(1).max(128),
  asn: z.string().max(64).optional(),
  as_name: z.string().max(512).optional(),
  as_domain: z.string().max(512).optional(),
  country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
  country: z.string().max(256).optional(),
  continent_code: z.string().regex(/^[A-Z]{2}$/).optional(),
  continent: z.string().max(256).optional(),
  bogon: z.boolean().optional(),
  anycast: z.boolean().optional(),
}).passthrough();

export interface IpinfoLiteResult {
  ip: string;
  countryCode: string | null;
  countryName: string | null;
  continentCode: string | null;
  continentName: string | null;
  asn: string | null;
  asName: string | null;
  asDomain: string | null;
  bogon: boolean;
  anycast: boolean;
  responseSha256: string;
  lookedUpAt: string;
}

export function exactCanonicalIp(entityKey: string): string {
  const candidate = entityKey.trim().toLowerCase();
  if (isIP(candidate) === 0) throw new Error("NODE-7 geography accepts only an exact canonical IP entity key");
  return candidate;
}

export function ipinfoLiteLookupUrl(ip: string, token: string): URL {
  const exactIp = exactCanonicalIp(ip);
  const secret = token.trim();
  if (!secret) throw new Error("IPinfo Lite token is required");
  const url = new URL(`https://api.ipinfo.io/lite/${encodeURIComponent(exactIp)}`);
  url.searchParams.set("token", secret);
  return url;
}

export async function lookupIpinfoLite(input: {
  ip: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<IpinfoLiteResult> {
  const url = ipinfoLiteLookupUrl(input.ip, input.token);
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 30_000) {
    throw new Error("Invalid IPinfo Lite timeout");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "BAYKUSH-Intelligence-Node/0.3",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`IPinfo Lite returned HTTP ${response.status}`);
    const json: unknown = await response.json();
    const parsed = responseSchema.parse(json);
    const requested = exactCanonicalIp(input.ip);
    if (exactCanonicalIp(parsed.ip) !== requested) throw new Error("IPinfo Lite response IP does not match requested canonical IP");
    const lookedUpAt = (input.now ?? (() => new Date()))().toISOString();
    return {
      ip: requested,
      countryCode: parsed.country_code ?? null,
      countryName: parsed.country ?? null,
      continentCode: parsed.continent_code ?? null,
      continentName: parsed.continent ?? null,
      asn: parsed.asn ?? null,
      asName: parsed.as_name ?? null,
      asDomain: parsed.as_domain ?? null,
      bogon: parsed.bogon ?? false,
      anycast: parsed.anycast ?? false,
      responseSha256: createHash("sha256").update(canonicalJsonStringify(parsed)).digest("hex"),
      lookedUpAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

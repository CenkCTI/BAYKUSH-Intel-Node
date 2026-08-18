import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).max(4096).optional(),
);

const schema = z.object({
  IPINFO_LITE_TOKEN: optionalSecret,
  NODE7_GEO_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(8_000),
  NODE7_GEO_REFRESH_HOURS: z.coerce.number().int().min(6).max(168).default(24),
});

export interface Node7GeographyConfig {
  ipinfoLiteToken: string | null;
  httpTimeoutMs: number;
  refreshHours: number;
}

export function node7GeographyConfig(env: NodeJS.ProcessEnv = process.env): Node7GeographyConfig {
  const parsed = schema.parse(env);
  return {
    ipinfoLiteToken: parsed.IPINFO_LITE_TOKEN ?? null,
    httpTimeoutMs: parsed.NODE7_GEO_HTTP_TIMEOUT_MS,
    refreshHours: parsed.NODE7_GEO_REFRESH_HOURS,
  };
}

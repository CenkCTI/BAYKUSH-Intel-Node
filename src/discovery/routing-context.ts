import { isIP } from "node:net";
import { pool } from "../db/pool.js";
import { exactCanonicalIp } from "./geography/ipinfo-lite.js";

export interface RoutingContextRow {
  bucketStart: Date;
  bucketEnd: Date;
  coveringPrefix: string;
  announced: boolean;
  withdrawn: boolean;
  coverageStatus: string;
  dataAvailability: string;
  acquisitionBasis: string;
  liveCollectionCoverage: string;
  captureProfileKey: string | null;
  captureProfileVersion: number | null;
}

export async function routingContextForIp(input: {
  entityType: string;
  entityKey: string;
  from: string;
  to: string;
  limit?: number;
}): Promise<Array<{
  bucketStart: string;
  bucketEnd: string;
  coveringPrefix: string;
  activityTypes: Array<"ANNOUNCEMENT" | "WITHDRAWAL" | "OBSERVED">;
  coverageStatus: string;
  dataAvailability: string;
  liveCollectionCoverage: string;
  acquisitionBasis: string;
  upstreamOrigin: "RIPE_RIS";
  captureProfile: { key: string | null; version: number | null };
  semanticBoundary: string;
}>> {
  if (input.entityType !== "IP") throw new Error("Infrastructure context supports only canonical IP entities");
  const ip = exactCanonicalIp(input.entityKey);
  if (isIP(ip) === 0) throw new Error("Invalid canonical IP");
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) throw new Error("Invalid routing context range");
  if (to.getTime() - from.getTime() > 24 * 60 * 60 * 1_000) throw new Error("Routing context range is limited to 24 hours");
  const limit = input.limit ?? 250;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Routing context limit must be 1..500");

  const result = await pool.query<RoutingContextRow>(
    `SELECT revision.bucket_start AS "bucketStart",revision.bucket_end AS "bucketEnd",
            match.prefix AS "coveringPrefix",
            (revision.announced_prefixes ? match.prefix) AS announced,
            (revision.withdrawn_prefixes ? match.prefix) AS withdrawn,
            revision.coverage_status AS "coverageStatus",
            revision.data_availability AS "dataAvailability",
            revision.acquisition_basis AS "acquisitionBasis",
            COALESCE(revision.live_collection_coverage_status,
              CASE WHEN revision.acquisition_basis='LIVE_STREAM' THEN revision.coverage_status ELSE 'NO_COVERAGE' END
            ) AS "liveCollectionCoverage",
            profile.profile_key AS "captureProfileKey",profile.profile_version AS "captureProfileVersion"
     FROM source_definitions source
     JOIN routing_minute_bucket_heads head ON head.source_definition_id=source.id
     JOIN routing_minute_bucket_revisions revision ON revision.id=head.current_revision_id
     LEFT JOIN stream_capture_profile_revisions profile ON profile.id=revision.capture_profile_revision_id
     JOIN LATERAL (
       SELECT prefix.value AS prefix
       FROM jsonb_array_elements_text(revision.all_prefixes) prefix(value)
       WHERE inet($1) <<= prefix.value::cidr
       ORDER BY masklen(prefix.value::cidr) DESC
       LIMIT 1
     ) match ON true
     WHERE source.source_key='RIPE_RIS_BGP'
       AND head.bucket_start >= $2 AND head.bucket_start < $3
     ORDER BY head.bucket_start DESC
     LIMIT $4`,
    [ip, from.toISOString(), to.toISOString(), limit],
  );

  return result.rows.map((row) => {
    const activityTypes: Array<"ANNOUNCEMENT" | "WITHDRAWAL" | "OBSERVED"> = [];
    if (row.announced) activityTypes.push("ANNOUNCEMENT");
    if (row.withdrawn) activityTypes.push("WITHDRAWAL");
    if (activityTypes.length === 0) activityTypes.push("OBSERVED");
    return {
      bucketStart: row.bucketStart.toISOString(),
      bucketEnd: row.bucketEnd.toISOString(),
      coveringPrefix: row.coveringPrefix,
      activityTypes,
      coverageStatus: row.coverageStatus,
      dataAvailability: row.dataAvailability,
      liveCollectionCoverage: row.liveCollectionCoverage,
      acquisitionBasis: row.acquisitionBasis,
      upstreamOrigin: "RIPE_RIS" as const,
      captureProfile: { key: row.captureProfileKey, version: row.captureProfileVersion },
      semanticBoundary: "Routing context is observed RIPE RIS movement. Announcement is not attack; withdrawal is not an outage verdict; no hijack inference is made.",
    };
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "../db/pool.js";
import { publicMeasurementRegistry } from "../measurement/registry.js";
import { sendEnvelope, sendError } from "./http.js";

const SOURCE_KEYS = ["CISA_KEV", "NVD_CVE", "FIRST_EPSS", "THREATFOX", "MALWAREBAZAAR"] as const;
const MAX_RECORDS = 100;

function limit(url: URL): number | null {
  const raw = url.searchParams.get("limit") ?? "25";
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= MAX_RECORDS ? parsed : null;
}

async function sources(response: ServerResponse, id: string): Promise<void> {
  const result = await pool.query(`SELECT source_key AS "sourceKey",display_name AS "displayName",source_class AS "sourceClass",observation_basis AS "observationBasis",collection_mode AS "collectionMode",recovery_strategy AS "recoveryStrategy",semantic_contract_version AS "semanticVersion",license_class AS "licenseClass",commercial_use_status AS "commercialUseStatus",redistribution_status AS "redistributionStatus",attribution_requirement AS "attributionRequirement",terms_reference AS "termsReference",represents,does_not_represent AS "doesNotRepresent" FROM source_definitions WHERE source_key=ANY($1::text[]) ORDER BY source_key`, [SOURCE_KEYS]);
  sendEnvelope(response, 200, result.rows, id, { count: result.rows.length });
}

async function statuses(response: ServerResponse, id: string): Promise<void> {
  const result = await pool.query(`SELECT source.source_key AS "sourceKey",source.display_name AS "displayName",'BAYKUSH_INTELLIGENCE_NODE' AS authority,COALESCE(health.health_status,'UNKNOWN') AS "operationalHealth",health.last_attempt_at AS "lastAttemptAt",health.last_success_at AS "lastSuccessfulCollectionAt",CASE WHEN health.last_success_at IS NULL THEN 'UNKNOWN' WHEN health.last_success_at > now()-make_interval(secs=>COALESCE(source.default_poll_interval_seconds,86400)*2) THEN 'FRESH' ELSE 'STALE' END AS freshness,COALESCE(latest.coverage_status,'NO_COVERAGE') AS coverage,COALESCE(availability.availability_status,'UNKNOWN') AS "dataAvailability",COALESCE(backfill.status,'NOT_REQUESTED') AS "historicalBackfillStatus" FROM source_definitions source LEFT JOIN source_health health ON health.source_definition_id=source.id LEFT JOIN LATERAL (SELECT revision.coverage_status FROM source_coverage_bucket_heads head JOIN source_coverage_bucket_revisions revision ON revision.id=head.current_revision_id WHERE head.source_definition_id=source.id ORDER BY head.bucket_end DESC LIMIT 1) latest ON true LEFT JOIN LATERAL (SELECT availability_status FROM source_acquisition_windows WHERE source_definition_id=source.id ORDER BY created_at DESC LIMIT 1) availability ON true LEFT JOIN LATERAL (SELECT status FROM historical_backfill_requests WHERE source_definition_id=source.id ORDER BY created_at DESC LIMIT 1) backfill ON true WHERE source.source_key=ANY($1::text[]) ORDER BY source.source_key`, [SOURCE_KEYS]);
  sendEnvelope(response, 200, result.rows, id, { note: "Operational health, freshness, coverage, availability and backfill state are independent." });
}

async function summary(url: URL, response: ServerResponse, id: string): Promise<void> {
  const preset = (url.searchParams.get("range") ?? "24H").toUpperCase();
  const duration = preset === "24H" ? "24 hours" : preset === "7D" ? "7 days" : preset === "30D" ? "30 days" : null;
  if (!duration) return sendError(response, 400, "INVALID_REQUEST", "range must be 24H, 7D or 30D", id);
  const result = await pool.query(`SELECT definition.measurement_key AS "measurementKey",definition.represents,definition.does_not_represent AS "doesNotRepresent",sum(revision.value_numeric)::double precision AS value,count(*)::int AS "bucketCount",bool_and(revision.value_numeric IS NOT NULL AND revision.coverage_status='COMPLETE') AS comparable FROM measurement_definition_heads head JOIN measurement_definitions definition ON definition.id=head.active_definition_id JOIN measurement_bucket_heads bucket ON bucket.measurement_calculation_id=head.active_calculation_id JOIN measurement_bucket_revisions revision ON revision.id=bucket.current_revision_id WHERE definition.visibility='PUBLIC' AND bucket.bucket_start>=now()-$1::interval AND bucket.bucket_start<now() GROUP BY definition.measurement_key,definition.represents,definition.does_not_represent ORDER BY definition.measurement_key`, [duration]);
  sendEnvelope(response, 200, { range: preset, measurements: result.rows }, id, { note: "Factual measurement summary; no global threat or risk score." });
}

async function records(url: URL, response: ServerResponse, id: string): Promise<void> {
  const pageLimit = limit(url); if (!pageLimit) return sendError(response, 400, "INVALID_REQUEST", "limit must be an integer from 1 to 100", id);
  const allowed = new Set(["sourceKey","recordKind","entityId","from","to","cursor","limit"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return sendError(response, 400, "INVALID_REQUEST", "Unsupported record filter", id);
  const result = await pool.query(`SELECT record.id,source.source_key AS "sourceKey",record.source_record_id AS "sourceRecordId",record.canonical_key AS "canonicalKey",record.record_kind AS "recordKind",record.received_at AS "receivedAt",record.published_at AS "publishedAt",record.effective_at AS "effectiveAt",record.upstream_updated_at AS "upstreamUpdatedAt",record.entities,record.facts,record.reference_urls AS "referenceUrls",record.semantic_boundary AS "semanticBoundary",record.normalization_version AS "normalizationVersion",record.created_at AS "createdAt" FROM canonical_evidence_records record JOIN source_definitions source ON source.id=record.source_definition_id WHERE ($1::text IS NULL OR source.source_key=$1) AND ($2::text IS NULL OR record.record_kind=$2) AND ($3::text IS NULL OR record.entities @> jsonb_build_array(jsonb_build_object('key',$3::text))) AND ($4::timestamptz IS NULL OR record.received_at >= $4) AND ($5::timestamptz IS NULL OR record.received_at < $5) AND ($6::uuid IS NULL OR record.id < $6) ORDER BY record.id DESC LIMIT $7`, [url.searchParams.get("sourceKey"),url.searchParams.get("recordKind"),url.searchParams.get("entityId"),url.searchParams.get("from"),url.searchParams.get("to"),url.searchParams.get("cursor"),pageLimit+1]);
  const rows=result.rows.slice(0,pageLimit); sendEnvelope(response,200,rows,id,{limit:pageLimit,nextCursor:result.rows.length>pageLimit?rows.at(-1)?.id:null});
}

async function entity(entityKey: string, response: ServerResponse, id: string): Promise<void> {
  const history=await pool.query(`SELECT entity_key AS "canonicalKey",entity_type AS kind,first_seen_time AS "firstSeenTime",first_seen_date AS "firstSeenDate",last_seen_time AS "lastSeenTime",last_seen_date AS "lastSeenDate",observation_count AS "observationCount",source_count AS "sourceCount",revision_acquisition_basis AS "acquisitionBasis",current_revision_id AS "revisionId" FROM entity_history_heads WHERE entity_key=$1 LIMIT 1`,[entityKey]);
  if(!history.rows[0]) return sendError(response,404,"NOT_FOUND","Entity not found",id);
  const observations=await pool.query(`SELECT head.observation_key AS "observationKey",head.entity_role AS role,source.source_key AS "sourceKey",head.observed_time AS "observedTime",head.observed_date AS "observedDate",head.acquisition_basis AS "acquisitionBasis",head.current_revision_id AS "revisionId" FROM entity_observation_heads head JOIN source_definitions source ON source.id=head.source_definition_id WHERE head.entity_key=$1 AND head.state='ACTIVE' ORDER BY COALESCE(head.observed_time,head.observed_date::timestamptz) DESC LIMIT 50`,[entityKey]);
  sendEnvelope(response,200,{entity:history.rows[0],observations:observations.rows},id,{observationLimit:50});
}

export async function handleReadApi(request: IncomingMessage,response: ServerResponse,url: URL,id: string): Promise<boolean> {
  if(request.method!=="GET") return false;
  if(url.pathname==="/v1/sources"){await sources(response,id);return true;}
  if(url.pathname==="/v1/sources/status"){await statuses(response,id);return true;}
  if(url.pathname==="/v1/techint/summary"){await summary(url,response,id);return true;}
  if(url.pathname==="/v1/techint/records"){await records(url,response,id);return true;}
  const entityMatch=url.pathname.match(/^\/v1\/techint\/entities\/(.+)$/);if(entityMatch?.[1]){await entity(decodeURIComponent(entityMatch[1]),response,id);return true;}
  return false;
}

export const node4PublicMeasurementKeys = publicMeasurementRegistry().map((entry)=>entry.definition.measurementKey);

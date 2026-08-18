import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "../db/pool.js";
import { lineageForEntity, relatedRecordsForEntity } from "../discovery/lineage.js";
import { routingContextForIp } from "../discovery/routing-context.js";
import { sendEnvelope, sendError } from "./http.js";

const MAX_RANGE_MS = 30 * 86_400_000;
const presets = new Map<string, number>([["24H",86_400_000],["7D",7*86_400_000],["30D",30*86_400_000]]);

function boundedLimit(url: URL, fallback = 25, maximum = 100): number | null {
  const raw = url.searchParams.get("limit") ?? String(fallback);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= maximum ? parsed : null;
}

function selectedRange(url: URL): { from: Date; to: Date } | null {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  if (Boolean(fromRaw) !== Boolean(toRaw)) return null;
  if (fromRaw && toRaw) {
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime()-from.getTime()>MAX_RANGE_MS) return null;
    return { from, to };
  }
  const preset = (url.searchParams.get("range") ?? "24H").toUpperCase();
  const duration = presets.get(preset);
  if (!duration) return null;
  const to = new Date();
  return { from: new Date(to.getTime()-duration), to };
}

function exactEntity(url: URL, encodedKey: string): { entityType: string; entityKey: string } | null {
  const entityType = url.searchParams.get("entityType")?.trim();
  if (!entityType) return null;
  try {
    const entityKey = decodeURIComponent(encodedKey).trim();
    return entityKey ? { entityType, entityKey } : null;
  } catch {
    return null;
  }
}

async function convergence(url: URL,response: ServerResponse,id:string):Promise<void>{
  const allowed=new Set(["range","from","to","entityType","findingType","minimumOrigins","sourceClass","limit","cursor"]);
  if([...url.searchParams.keys()].some((key)=>!allowed.has(key)))return sendError(response,400,"INVALID_REQUEST","Unsupported convergence filter",id);
  const range=selectedRange(url),limit=boundedLimit(url);if(!range||!limit)return sendError(response,400,"INVALID_REQUEST","Invalid convergence range or limit",id);
  const minimumRaw=url.searchParams.get("minimumOrigins")??"1";if(!/^\d+$/.test(minimumRaw))return sendError(response,400,"INVALID_REQUEST","minimumOrigins must be an integer",id);
  const minimumOrigins=Number(minimumRaw);if(minimumOrigins<1||minimumOrigins>100)return sendError(response,400,"INVALID_REQUEST","minimumOrigins must be 1..100",id);
  const result=await pool.query(`SELECT revision.id,revision.finding_key AS "findingKey",revision.finding_type AS "findingType",
      revision.entity_type AS "entityType",revision.entity_key AS "entityKey",revision.resolution,
      revision.window_start AS "windowStart",revision.window_end AS "windowEnd",revision.time_precision AS "timePrecision",
      revision.source_definition_count AS "sourceDefinitionCount",revision.upstream_origin_count AS "upstreamOriginCount",
      revision.source_class_count AS "sourceClassCount",revision.observation_count AS "observationCount",
      revision.first_observed_time AS "firstObservedTime",revision.last_observed_time AS "lastObservedTime",
      revision.first_observed_date AS "firstObservedDate",revision.last_observed_date AS "lastObservedDate",
      revision.observation_span_seconds::text AS "observationSpanSeconds",revision.policy_revision_id AS "policyRevisionId",
      revision.calculated_at AS "calculatedAt"
    FROM convergence_finding_heads head JOIN convergence_finding_revisions revision ON revision.id=head.current_revision_id
    WHERE head.state='ACTIVE' AND head.window_start >= $1 AND head.window_start < $2
      AND ($3::text IS NULL OR head.entity_type=$3) AND ($4::text IS NULL OR head.finding_type=$4)
      AND revision.upstream_origin_count >= $5
      AND ($6::text IS NULL OR EXISTS (
        SELECT 1 FROM convergence_finding_inputs fi
        JOIN entity_activity_bucket_members member ON member.bucket_revision_id=fi.activity_bucket_revision_id
        WHERE fi.finding_revision_id=revision.id AND member.source_class=$6
      ))
      AND ($7::uuid IS NULL OR revision.id<$7)
    ORDER BY head.window_start DESC,revision.id DESC LIMIT $8`,[
      range.from.toISOString(),range.to.toISOString(),url.searchParams.get("entityType"),url.searchParams.get("findingType"),minimumOrigins,
      url.searchParams.get("sourceClass"),url.searchParams.get("cursor"),limit+1]);
  const rows=result.rows.slice(0,limit);sendEnvelope(response,200,rows,id,{selectedRange:{from:range.from.toISOString(),to:range.to.toISOString()},limit,nextCursor:result.rows.length>limit?rows.at(-1)?.id??null:null,note:"Deterministic exact-entity convergence; correlation is not causation or attribution."});
}

async function newEntities(url:URL,response:ServerResponse,id:string):Promise<void>{
  const allowed=new Set(["range","from","to","entityType","includeHistorical","limit","cursor"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key)))return sendError(response,400,"INVALID_REQUEST","Unsupported new-entity filter",id);
  const range=selectedRange(url),limit=boundedLimit(url);if(!range||!limit)return sendError(response,400,"INVALID_REQUEST","Invalid discovery range or limit",id);
  const includeHistorical=url.searchParams.get("includeHistorical")==="true";
  const result=await pool.query(`SELECT revision.id,revision.finding_key AS "findingKey",revision.finding_type AS "findingType",
      revision.entity_type AS "entityType",revision.entity_key AS "entityKey",
      revision.effective_first_seen_time AS "effectiveFirstSeenTime",revision.effective_first_seen_date AS "effectiveFirstSeenDate",
      revision.time_precision AS "timePrecision",revision.node_discovered_at AS "nodeDiscoveredAt",
      revision.acquisition_basis AS "acquisitionBasis",revision.policy_revision_id AS "policyRevisionId",revision.calculated_at AS "calculatedAt"
    FROM discovery_finding_heads head JOIN discovery_finding_revisions revision ON revision.id=head.current_revision_id
    WHERE head.state='ACTIVE' AND head.finding_type=ANY($1::text[])
      AND ($2::text IS NULL OR head.entity_type=$2)
      AND COALESCE(revision.effective_first_seen_time,revision.effective_first_seen_date::timestamptz) >= $3
      AND COALESCE(revision.effective_first_seen_time,revision.effective_first_seen_date::timestamptz) < $4
      AND ($5::uuid IS NULL OR revision.id<$5)
    ORDER BY COALESCE(revision.effective_first_seen_time,revision.effective_first_seen_date::timestamptz) DESC,revision.id DESC LIMIT $6`,[
      includeHistorical?["NEW_ENTITY","HISTORICAL_DISCOVERY"]:["NEW_ENTITY"],url.searchParams.get("entityType"),range.from.toISOString(),range.to.toISOString(),url.searchParams.get("cursor"),limit+1]);
  const rows=result.rows.slice(0,limit);sendEnvelope(response,200,rows,id,{selectedRange:{from:range.from.toISOString(),to:range.to.toISOString()},limit,nextCursor:result.rows.length>limit?rows.at(-1)?.id??null:null,note:"Effective first-seen time drives novelty. Historical acquisition is separated from current novelty."});
}

async function composition(url:URL,response:ServerResponse,id:string,topMovers=false):Promise<void>{
  const allowed=new Set(["range","from","to","entityType","limit","cursor"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key)))return sendError(response,400,"INVALID_REQUEST","Unsupported composition filter",id);
  const range=selectedRange(url),limit=boundedLimit(url);if(!range||!limit)return sendError(response,400,"INVALID_REQUEST","Invalid composition range or limit",id);
  const order=topMovers?'revision.new_upstream_origin_count DESC,revision.new_source_class_count DESC,revision.new_source_definition_count DESC,head.window_start DESC,revision.id DESC':'head.window_start DESC,revision.id DESC';
  const result=await pool.query(`SELECT revision.id,revision.finding_key AS "findingKey",revision.entity_type AS "entityType",
      revision.entity_key AS "entityKey",revision.window_start AS "windowStart",revision.window_end AS "windowEnd",
      revision.new_source_definition_count AS "newSourceDefinitionCount",revision.new_upstream_origin_count AS "newUpstreamOriginCount",
      revision.new_source_class_count AS "newSourceClassCount",revision.new_source_definition_keys AS "newSourceDefinitionKeys",
      revision.new_upstream_origin_keys AS "newUpstreamOriginKeys",revision.new_source_classes AS "newSourceClasses",
      revision.policy_revision_id AS "policyRevisionId",revision.calculated_at AS "calculatedAt"
    FROM discovery_finding_heads head JOIN discovery_finding_revisions revision ON revision.id=head.current_revision_id
    WHERE head.state='ACTIVE' AND head.finding_type='COMPOSITION_EXPANSION'
      AND head.window_start >= $1 AND head.window_start < $2 AND ($3::text IS NULL OR head.entity_type=$3)
      AND ($4::uuid IS NULL OR revision.id<$4)
    ORDER BY ${order} LIMIT $5`,[range.from.toISOString(),range.to.toISOString(),url.searchParams.get("entityType"),url.searchParams.get("cursor"),limit+1]);
  const rows=result.rows.slice(0,limit);sendEnvelope(response,200,rows,id,{selectedRange:{from:range.from.toISOString(),to:range.to.toISOString()},limit,nextCursor:result.rows.length>limit?rows.at(-1)?.id??null:null,note:topMovers?"Top movers are explainable composition expansion, not threat/risk ranking.":"Positive composition expansion only; absence is not declared removal."});
}

async function discoverySummary(url:URL,response:ServerResponse,id:string):Promise<void>{
  const allowed=new Set(["range","from","to"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key)))return sendError(response,400,"INVALID_REQUEST","Unsupported discovery summary filter",id);
  const range=selectedRange(url);if(!range)return sendError(response,400,"INVALID_REQUEST","Invalid discovery range",id);
  const [convergenceCounts,newCount,compositionCount,top]=await Promise.all([
    pool.query(`SELECT revision.finding_type AS "findingType",count(*)::int AS count FROM convergence_finding_heads head JOIN convergence_finding_revisions revision ON revision.id=head.current_revision_id WHERE head.state='ACTIVE' AND head.window_start >= $1 AND head.window_start < $2 GROUP BY revision.finding_type ORDER BY revision.finding_type`,[range.from.toISOString(),range.to.toISOString()]),
    pool.query(`SELECT count(*)::int AS count FROM discovery_finding_heads head JOIN discovery_finding_revisions revision ON revision.id=head.current_revision_id WHERE head.state='ACTIVE' AND head.finding_type='NEW_ENTITY' AND COALESCE(revision.effective_first_seen_time,revision.effective_first_seen_date::timestamptz) >= $1 AND COALESCE(revision.effective_first_seen_time,revision.effective_first_seen_date::timestamptz) < $2`,[range.from.toISOString(),range.to.toISOString()]),
    pool.query(`SELECT count(*)::int AS count FROM discovery_finding_heads WHERE state='ACTIVE' AND finding_type='COMPOSITION_EXPANSION' AND window_start >= $1 AND window_start < $2`,[range.from.toISOString(),range.to.toISOString()]),
    pool.query(`SELECT revision.entity_type AS "entityType",revision.entity_key AS "entityKey",revision.new_upstream_origin_count AS "newUpstreamOriginCount",revision.new_source_class_count AS "newSourceClassCount",revision.new_source_definition_count AS "newSourceDefinitionCount",revision.window_start AS "windowStart" FROM discovery_finding_heads head JOIN discovery_finding_revisions revision ON revision.id=head.current_revision_id WHERE head.state='ACTIVE' AND head.finding_type='COMPOSITION_EXPANSION' AND head.window_start >= $1 AND head.window_start < $2 ORDER BY revision.new_upstream_origin_count DESC,revision.new_source_class_count DESC,revision.new_source_definition_count DESC,head.window_start DESC LIMIT 10`,[range.from.toISOString(),range.to.toISOString()]),
  ]);
  sendEnvelope(response,200,{convergenceCounts:convergenceCounts.rows,newEntityCount:newCount.rows[0]?.count??0,compositionExpansionCount:compositionCount.rows[0]?.count??0,topMovers:top.rows},id,{selectedRange:{from:range.from.toISOString(),to:range.to.toISOString()},note:"Discovery is deterministic technical movement, not a global threat score."});
}

async function geoMap(url:URL,response:ServerResponse,id:string):Promise<void>{
  const allowed=new Set(["range","from","to","geoClass"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key)))return sendError(response,400,"INVALID_REQUEST","Unsupported geography map filter",id);
  const range=selectedRange(url);if(!range)return sendError(response,400,"INVALID_REQUEST","Invalid geography range",id);
  const geoClass=url.searchParams.get("geoClass")??"OBSERVED_INFRASTRUCTURE_LOCATION";
  if(!["OBSERVED_INFRASTRUCTURE_LOCATION","REPORTED_TARGET","REPORTED_ACTIVITY"].includes(geoClass))return sendError(response,400,"INVALID_REQUEST","Unsupported geoClass",id);
  const result=await pool.query(`SELECT revision.country_code AS "countryCode",max(revision.country_name) AS "countryName",
      count(DISTINCT (revision.subject_entity_type,revision.subject_entity_key))::int AS "observedEntityCount",
      count(DISTINCT revision.basis_source_definition_id)::int AS "sourceSystemCount",
      count(DISTINCT source.upstream_origin_key)::int AS "upstreamOriginCount"
    FROM geographic_assertion_heads head JOIN geographic_assertion_revisions revision ON revision.id=head.current_revision_id
    JOIN source_definitions source ON source.id=revision.basis_source_definition_id
    WHERE head.state='ACTIVE' AND head.geo_class=$1 AND revision.country_code IS NOT NULL
      AND COALESCE(revision.observed_time,revision.observed_date::timestamptz) >= $2
      AND COALESCE(revision.observed_time,revision.observed_date::timestamptz) < $3
    GROUP BY revision.country_code ORDER BY "observedEntityCount" DESC,revision.country_code LIMIT 250`,[geoClass,range.from.toISOString(),range.to.toISOString()]);
  sendEnvelope(response,200,{geoClass,countries:result.rows},id,{selectedRange:{from:range.from.toISOString(),to:range.to.toISOString()},attribution:"IP address data powered by IPinfo where IPinfo Lite is the assertion basis.",note:"Geography classes are explicit. Infrastructure location is not attacker origin."});
}

async function entityGeography(entityType:string,entityKey:string,response:ServerResponse,id:string):Promise<void>{
  const result=await pool.query(`SELECT revision.id,revision.geo_class AS "geoClass",revision.country_code AS "countryCode",revision.country_name AS "countryName",
      revision.continent_code AS "continentCode",revision.continent_name AS "continentName",revision.location_precision AS "locationPrecision",
      revision.basis_type AS "basisType",source.source_key AS "basisSourceKey",source.upstream_origin_key AS "upstreamOriginKey",
      revision.observed_time AS "observedTime",revision.observed_date AS "observedDate",revision.time_precision AS "timePrecision",
      revision.temporal_policy AS "temporalPolicy",revision.quality_class AS "qualityClass",revision.provider_context AS "providerContext",
      revision.policy_revision_id AS "policyRevisionId",revision.created_at AS "createdAt"
    FROM geographic_assertion_heads head JOIN geographic_assertion_revisions revision ON revision.id=head.current_revision_id
    JOIN source_definitions source ON source.id=revision.basis_source_definition_id
    WHERE head.state='ACTIVE' AND head.subject_entity_type=$1 AND head.subject_entity_key=$2
    ORDER BY COALESCE(revision.observed_time,revision.observed_date::timestamptz) DESC LIMIT 50`,[entityType,entityKey]);
  sendEnvelope(response,200,result.rows,id,{count:result.rows.length,note:"Geographic assertions retain explicit class, basis and temporal policy; they do not imply attacker origin."});
}

export async function handleNode7ReadApi(request:IncomingMessage,response:ServerResponse,url:URL,id:string):Promise<boolean>{
  if(request.method!=="GET")return false;
  if(url.pathname==="/v1/techint/discovery"){await discoverySummary(url,response,id);return true;}
  if(url.pathname==="/v1/techint/convergence"){await convergence(url,response,id);return true;}
  if(url.pathname==="/v1/techint/discovery/new-entities"){await newEntities(url,response,id);return true;}
  if(url.pathname==="/v1/techint/discovery/composition"){await composition(url,response,id,false);return true;}
  if(url.pathname==="/v1/techint/discovery/top-movers"){await composition(url,response,id,true);return true;}
  if(url.pathname==="/v1/techint/geography/map"){await geoMap(url,response,id);return true;}
  const entityMatch=url.pathname.match(/^\/v1\/techint\/entities\/([^/]+)\/(related-records|lineage|geography|infrastructure-context)$/);
  if(entityMatch?.[1]&&entityMatch[2]){
    const entity=exactEntity(url,entityMatch[1]);if(!entity){sendError(response,400,"INVALID_REQUEST","entityType and an encoded exact canonical entity key are required",id);return true;}
    if(entityMatch[2]==="related-records"){
      const allowed=new Set(["entityType","from","to","sourceKey","sourceClass","limit","cursor"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key))){sendError(response,400,"INVALID_REQUEST","Unsupported related-record filter",id);return true;}
      const limit=boundedLimit(url);if(!limit){sendError(response,400,"INVALID_REQUEST","limit must be 1..100",id);return true;}
      const data=await relatedRecordsForEntity({entityType:entity.entityType,entityKey:entity.entityKey,from:url.searchParams.get("from"),to:url.searchParams.get("to"),sourceKey:url.searchParams.get("sourceKey"),sourceClass:url.searchParams.get("sourceClass"),limit,cursor:url.searchParams.get("cursor")});sendEnvelope(response,200,data,id,{note:"Relationship basis is exact canonical entity overlap."});return true;
    }
    if(entityMatch[2]==="lineage"){
      const allowed=new Set(["entityType","depth","limit"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key))){sendError(response,400,"INVALID_REQUEST","Unsupported lineage filter",id);return true;}
      const depthRaw=url.searchParams.get("depth")??"3",limitRaw=url.searchParams.get("limit")??"100";if(!/^\d+$/.test(depthRaw)||!/^\d+$/.test(limitRaw)){sendError(response,400,"INVALID_REQUEST","Invalid lineage bounds",id);return true;}
      const data=await lineageForEntity({entityType:entity.entityType,entityKey:entity.entityKey,depth:Number(depthRaw),nodeLimit:Number(limitRaw)});sendEnvelope(response,200,data,id,{note:"Bounded provenance graph; raw source payloads are not returned."});return true;
    }
    if(entityMatch[2]==="geography"){
      const allowed=new Set(["entityType"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key))){sendError(response,400,"INVALID_REQUEST","Unsupported entity geography filter",id);return true;}
      await entityGeography(entity.entityType,entity.entityKey,response,id);return true;
    }
    const allowed=new Set(["entityType","from","to","limit"]);if([...url.searchParams.keys()].some((key)=>!allowed.has(key))){sendError(response,400,"INVALID_REQUEST","Unsupported infrastructure-context filter",id);return true;}
    const toRaw=url.searchParams.get("to")??new Date().toISOString();const to=new Date(toRaw);const fromRaw=url.searchParams.get("from")??new Date(to.getTime()-60*60*1000).toISOString();const limit=boundedLimit(url,250,500);if(!limit){sendError(response,400,"INVALID_REQUEST","limit must be 1..500",id);return true;}
    try{const data=await routingContextForIp({entityType:entity.entityType,entityKey:entity.entityKey,from:fromRaw,to:toRaw,limit});sendEnvelope(response,200,data,id,{count:data.length,attribution:"RIPE NCC Routing Information Service (RIS)",note:"Routing movement is context only; no attack, outage or hijack inference."});}catch(error){sendError(response,400,"INVALID_REQUEST",error instanceof Error?error.message:"Invalid infrastructure context request",id);}return true;
  }
  return false;
}

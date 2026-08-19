import { pool } from "../db/pool.js";

export interface RelatedRecordQuery {
  entityType: string;
  entityKey: string;
  from: string | null;
  to: string | null;
  sourceKey: string | null;
  sourceClass: string | null;
  limit: number;
  cursor: string | null;
}

export async function relatedRecordsForEntity(query: RelatedRecordQuery): Promise<{
  relationshipBasis: "EXACT_CANONICAL_ENTITY_OVERLAP";
  records: unknown[];
  nextCursor: string | null;
}> {
  if (!query.entityType.trim() || !query.entityKey.trim()) throw new Error("Exact entity type/key required");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("Related-record limit must be 1..100");

  const result = await pool.query(
    `SELECT record.id,source.source_key AS "sourceKey",source.source_class AS "sourceClass",
            source.upstream_origin_key AS "upstreamOriginKey",record.source_record_id AS "sourceRecordId",
            record.canonical_key AS "canonicalKey",record.record_kind AS "recordKind",
            record.received_at AS "receivedAt",record.published_at AS "publishedAt",
            record.effective_at AS "effectiveAt",record.upstream_updated_at AS "upstreamUpdatedAt",
            record.entities,record.facts,record.reference_urls AS "referenceUrls",
            record.semantic_boundary AS "semanticBoundary",record.normalization_version AS "normalizationVersion"
     FROM canonical_evidence_records record
     JOIN source_definitions source ON source.id=record.source_definition_id
     WHERE record.entities @> jsonb_build_array(jsonb_build_object('kind',$1::text,'key',$2::text))
       AND ($3::text IS NULL OR source.source_key=$3)
       AND ($4::text IS NULL OR source.source_class=$4)
       AND ($5::timestamptz IS NULL OR COALESCE(record.effective_at,record.published_at,record.upstream_updated_at,record.received_at) >= $5)
       AND ($6::timestamptz IS NULL OR COALESCE(record.effective_at,record.published_at,record.upstream_updated_at,record.received_at) < $6)
       AND ($7::uuid IS NULL OR record.id < $7)
     ORDER BY record.id DESC
     LIMIT $8`,
    [
      query.entityType,
      query.entityKey,
      query.sourceKey,
      query.sourceClass,
      query.from,
      query.to,
      query.cursor,
      query.limit + 1,
    ],
  );
  const records = result.rows.slice(0, query.limit);
  return {
    relationshipBasis: "EXACT_CANONICAL_ENTITY_OVERLAP",
    records,
    nextCursor: result.rows.length > query.limit
      ? (records.at(-1) as { id?: string } | undefined)?.id ?? null
      : null,
  };
}

export type LineageNodeType =
  | "ENTITY"
  | "SOURCE_DEFINITION"
  | "RAW_SOURCE_RECORD"
  | "CANONICAL_RECORD"
  | "ENTITY_OBSERVATION_REVISION"
  | "ENTITY_HISTORY_REVISION"
  | "ACTIVITY_BUCKET_REVISION"
  | "CONVERGENCE_FINDING_REVISION";

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  data: Record<string, unknown>;
}

export interface LineageEdge {
  from: string;
  to: string;
  relation:
    | "COLLECTED_FROM"
    | "NORMALIZED_FROM"
    | "ASSERTS_ENTITY"
    | "CONTRIBUTES_TO_HISTORY"
    | "CONTRIBUTES_TO_ACTIVITY"
    | "SUPPORTS_CONVERGENCE";
}

function pushNode(nodes: Map<string, LineageNode>, node: LineageNode, limit: number): void {
  if (nodes.has(node.id)) return;
  if (nodes.size >= limit) return;
  nodes.set(node.id, node);
}

export async function lineageForEntity(input: {
  entityType: string;
  entityKey: string;
  depth?: number;
  nodeLimit?: number;
}): Promise<{ nodes: LineageNode[]; edges: LineageEdge[]; truncated: boolean }> {
  const depth = input.depth ?? 3;
  const nodeLimit = input.nodeLimit ?? 100;
  if (!input.entityType.trim() || !input.entityKey.trim()) throw new Error("Exact entity type/key required");
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error("Lineage depth must be 1..3");
  if (!Number.isInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > 100) throw new Error("Lineage node limit must be 1..100");

  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const entityId = `entity:${input.entityType}:${input.entityKey}`;
  pushNode(nodes, { id: entityId, type: "ENTITY", data: { entityType: input.entityType, entityKey: input.entityKey } }, nodeLimit);

  const history = await pool.query(
    `SELECT revision.id,revision.revision_number AS "revisionNumber",
            revision.first_seen_time AS "firstSeenTime",revision.first_seen_date AS "firstSeenDate",
            revision.last_seen_time AS "lastSeenTime",revision.last_seen_date AS "lastSeenDate",
            revision.observation_count AS "observationCount",revision.source_count AS "sourceCount",
            revision.revision_acquisition_basis AS "acquisitionBasis",revision.calculated_at AS "calculatedAt"
     FROM entity_history_heads head
     JOIN entity_history_revisions revision ON revision.id=head.current_revision_id
     WHERE head.entity_type=$1 AND head.entity_key=$2`,
    [input.entityType, input.entityKey],
  );
  const historyRow = history.rows[0] as { id?: string } | undefined;
  if (historyRow?.id) {
    const historyId = `history:${historyRow.id}`;
    pushNode(nodes, { id: historyId, type: "ENTITY_HISTORY_REVISION", data: historyRow as Record<string, unknown> }, nodeLimit);
    edges.push({ from: entityId, to: historyId, relation: "CONTRIBUTES_TO_HISTORY" });
  }

  if (depth >= 1) {
    const observations = await pool.query(
      `SELECT revision.id,revision.observation_key AS "observationKey",revision.entity_role AS role,
              revision.observation_basis AS "observationBasis",revision.acquisition_basis AS "acquisitionBasis",
              revision.observed_time AS "observedTime",revision.observed_date AS "observedDate",
              revision.canonical_record_id AS "canonicalRecordId",revision.raw_record_id AS "rawRecordId",
              source.id AS "sourceDefinitionId",source.source_key AS "sourceKey",
              source.upstream_origin_key AS "upstreamOriginKey",source.source_class AS "sourceClass"
       FROM entity_observation_heads head
       JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
       JOIN source_definitions source ON source.id=head.source_definition_id
       WHERE head.entity_type=$1 AND head.entity_key=$2 AND head.state='ACTIVE'
       ORDER BY COALESCE(head.observed_time,head.observed_date::timestamptz) DESC,revision.id
       LIMIT 50`,
      [input.entityType, input.entityKey],
    );
    for (const row of observations.rows as Array<Record<string, unknown> & { id: string; canonicalRecordId: string; rawRecordId: string; sourceDefinitionId: string }>) {
      const observationId = `observation:${row.id}`;
      pushNode(nodes, { id: observationId, type: "ENTITY_OBSERVATION_REVISION", data: row }, nodeLimit);
      edges.push({ from: observationId, to: entityId, relation: "ASSERTS_ENTITY" });

      if (depth >= 2) {
        const canonicalId = `canonical:${row.canonicalRecordId}`;
        const canonical = await pool.query(
          `SELECT record.id,record.canonical_key AS "canonicalKey",record.record_kind AS "recordKind",
                  record.source_record_id AS "sourceRecordId",record.received_at AS "receivedAt",
                  record.effective_at AS "effectiveAt",record.semantic_boundary AS "semanticBoundary",
                  record.raw_record_id AS "rawRecordId"
           FROM canonical_evidence_records record WHERE record.id=$1`,
          [row.canonicalRecordId],
        );
        const canonicalRow = canonical.rows[0] as Record<string, unknown> | undefined;
        if (canonicalRow) {
          pushNode(nodes, { id: canonicalId, type: "CANONICAL_RECORD", data: canonicalRow }, nodeLimit);
          edges.push({ from: canonicalId, to: observationId, relation: "ASSERTS_ENTITY" });
        }

        if (depth >= 3) {
          const rawId = `raw:${row.rawRecordId}`;
          const sourceId = `source:${row.sourceDefinitionId}`;
          const raw = await pool.query(
            `SELECT id,source_record_id AS "sourceRecordId",payload_sha256 AS "payloadSha256",
                    received_at AS "receivedAt",published_at AS "publishedAt",effective_at AS "effectiveAt",
                    upstream_updated_at AS "upstreamUpdatedAt",adapter_version AS "adapterVersion"
             FROM raw_source_records WHERE id=$1`,
            [row.rawRecordId],
          );
          const rawRow = raw.rows[0] as Record<string, unknown> | undefined;
          if (rawRow) {
            pushNode(nodes, { id: rawId, type: "RAW_SOURCE_RECORD", data: rawRow }, nodeLimit);
            edges.push({ from: rawId, to: canonicalId, relation: "NORMALIZED_FROM" });
          }
          pushNode(nodes, {
            id: sourceId,
            type: "SOURCE_DEFINITION",
            data: {
              sourceDefinitionId: row.sourceDefinitionId,
              sourceKey: row.sourceKey,
              upstreamOriginKey: row.upstreamOriginKey,
              sourceClass: row.sourceClass,
            },
          }, nodeLimit);
          edges.push({ from: rawId, to: sourceId, relation: "COLLECTED_FROM" });
        }
      }
    }
  }

  const activity = await pool.query(
    `SELECT revision.id,revision.resolution,revision.bucket_start AS "bucketStart",
            revision.bucket_end AS "bucketEnd",revision.observation_count AS "observationCount",
            revision.source_definition_count AS "sourceDefinitionCount",
            revision.upstream_origin_count AS "upstreamOriginCount",revision.source_class_count AS "sourceClassCount"
     FROM entity_activity_bucket_heads head
     JOIN entity_activity_bucket_revisions revision ON revision.id=head.current_revision_id
     WHERE head.entity_type=$1 AND head.entity_key=$2 AND head.state='ACTIVE'
     ORDER BY head.bucket_start DESC LIMIT 10`,
    [input.entityType, input.entityKey],
  );
  for (const row of activity.rows as Array<Record<string, unknown> & { id: string }>) {
    const activityId = `activity:${row.id}`;
    pushNode(nodes, { id: activityId, type: "ACTIVITY_BUCKET_REVISION", data: row }, nodeLimit);
    edges.push({ from: entityId, to: activityId, relation: "CONTRIBUTES_TO_ACTIVITY" });
  }

  const findings = await pool.query(
    `SELECT revision.id,revision.finding_type AS "findingType",revision.resolution,
            revision.window_start AS "windowStart",revision.window_end AS "windowEnd",
            revision.source_definition_count AS "sourceDefinitionCount",
            revision.upstream_origin_count AS "upstreamOriginCount",
            revision.source_class_count AS "sourceClassCount",input.activity_bucket_revision_id AS "activityRevisionId"
     FROM convergence_finding_heads head
     JOIN convergence_finding_revisions revision ON revision.id=head.current_revision_id
     JOIN convergence_finding_inputs input ON input.finding_revision_id=revision.id
     WHERE head.entity_type=$1 AND head.entity_key=$2 AND head.state='ACTIVE'
     ORDER BY head.window_start DESC LIMIT 20`,
    [input.entityType, input.entityKey],
  );
  for (const row of findings.rows as Array<Record<string, unknown> & { id: string; activityRevisionId: string }>) {
    const findingId = `finding:${row.id}`;
    const activityId = `activity:${row.activityRevisionId}`;
    pushNode(nodes, { id: findingId, type: "CONVERGENCE_FINDING_REVISION", data: row }, nodeLimit);
    if (nodes.has(activityId)) edges.push({ from: activityId, to: findingId, relation: "SUPPORTS_CONVERGENCE" });
  }

  const validNodeIds = new Set(nodes.keys());
  const boundedEdges = edges.filter((edge) => validNodeIds.has(edge.from) && validNodeIds.has(edge.to)).slice(0, 200);
  return {
    nodes: [...nodes.values()],
    edges: boundedEdges,
    truncated: nodes.size >= nodeLimit || edges.length > boundedEdges.length,
  };
}

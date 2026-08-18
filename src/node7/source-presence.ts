import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import {
  presenceInputFingerprint,
  summarizePresenceObservations,
  type PresenceObservationCandidate,
  type SourceSemanticSnapshot,
} from "./contracts.js";

interface ObservationHeadRow {
  observation_revision_id: string;
  observation_state: "ACTIVE" | "RETRACTED";
  entity_role: string;
  observed_time: Date | null;
  observed_date: string | null;
  acquisition_basis: string;
  node_received_at: Date;
  source_definition_id: string;
  source_key: string;
  source_class: string;
  observation_basis: SourceSemanticSnapshot["observationBasis"];
  upstream_origin_key: string;
  semantic_contract_version: string;
}

interface PriorSourceRow {
  source_definition_id: string;
  source_key: string;
  source_class: string;
  observation_basis: SourceSemanticSnapshot["observationBasis"];
  upstream_origin_key: string;
  semantic_contract_version: string;
}

interface SourceGroup {
  source: SourceSemanticSnapshot;
  observations: PresenceObservationCandidate[];
}

function semanticSnapshot(row: ObservationHeadRow | PriorSourceRow): SourceSemanticSnapshot {
  return {
    sourceDefinitionId: row.source_definition_id,
    sourceKey: row.source_key,
    sourceClass: row.source_class,
    observationBasis: row.observation_basis,
    upstreamOriginKey: row.upstream_origin_key,
    semanticContractVersion: row.semantic_contract_version,
  };
}

async function appendPresenceRevision(input: {
  client: PoolClient;
  entityId: string;
  source: SourceSemanticSnapshot;
  observations: readonly PresenceObservationCandidate[];
}): Promise<boolean> {
  const summary = summarizePresenceObservations(input.observations);
  const fingerprint = presenceInputFingerprint(input.source, input.observations);

  const current = await input.client.query<{
    current_revision_id: string;
    revision_number: number;
    input_fingerprint: string;
    state: "ACTIVE" | "RETRACTED";
  }>(
    `SELECT head.current_revision_id,revision.revision_number,
            revision.input_fingerprint,head.state
     FROM entity_source_presence_heads head
     JOIN entity_source_presence_revisions revision ON revision.id=head.current_revision_id
     WHERE head.entity_id=$1 AND head.source_definition_id=$2
     FOR UPDATE OF head`,
    [input.entityId, input.source.sourceDefinitionId],
  );
  const prior = current.rows[0];
  if (prior?.input_fingerprint === fingerprint && prior.state === summary.state) return false;

  const inserted = await input.client.query<{ id: string }>(
    `INSERT INTO entity_source_presence_revisions(
       entity_id,source_definition_id,revision_number,state,
       first_seen_time,first_seen_date,last_seen_time,last_seen_date,
       first_node_received_at,last_node_received_at,
       observation_count,primary_observation_count,related_observation_count,
       source_class_snapshot,observation_basis_snapshot,upstream_origin_key_snapshot,
       semantic_contract_version_snapshot,acquisition_bases,time_precision_summary,
       input_fingerprint,supersedes_revision_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21
     ) RETURNING id`,
    [
      input.entityId,
      input.source.sourceDefinitionId,
      (prior?.revision_number ?? 0) + 1,
      summary.state,
      summary.firstSeenTime,
      summary.firstSeenDate,
      summary.lastSeenTime,
      summary.lastSeenDate,
      summary.firstNodeReceivedAt,
      summary.lastNodeReceivedAt,
      summary.observationCount,
      summary.primaryObservationCount,
      summary.relatedObservationCount,
      input.source.sourceClass,
      input.source.observationBasis,
      input.source.upstreamOriginKey,
      input.source.semanticContractVersion,
      JSON.stringify(summary.acquisitionBases),
      summary.timePrecisionSummary,
      fingerprint,
      prior?.current_revision_id ?? null,
    ],
  );
  const revisionId = inserted.rows[0]?.id;
  if (!revisionId) throw new Error("NODE-7 failed to append source-presence revision");

  for (const observationRevisionId of [...new Set(input.observations.map((row) => row.revisionId))].sort()) {
    await input.client.query(
      `INSERT INTO entity_source_presence_inputs(presence_revision_id,entity_observation_revision_id)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [revisionId, observationRevisionId],
    );
  }

  await input.client.query(
    `INSERT INTO entity_source_presence_heads(
       entity_id,source_definition_id,current_revision_id,state,
       first_seen_time,first_seen_date,last_seen_time,last_seen_date,
       first_node_received_at,last_node_received_at,
       observation_count,primary_observation_count,related_observation_count,
       source_class_snapshot,observation_basis_snapshot,upstream_origin_key_snapshot,
       semantic_contract_version_snapshot,acquisition_bases,time_precision_summary,updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,now()
     )
     ON CONFLICT (entity_id,source_definition_id) DO UPDATE SET
       current_revision_id=EXCLUDED.current_revision_id,
       state=EXCLUDED.state,
       first_seen_time=EXCLUDED.first_seen_time,
       first_seen_date=EXCLUDED.first_seen_date,
       last_seen_time=EXCLUDED.last_seen_time,
       last_seen_date=EXCLUDED.last_seen_date,
       first_node_received_at=EXCLUDED.first_node_received_at,
       last_node_received_at=EXCLUDED.last_node_received_at,
       observation_count=EXCLUDED.observation_count,
       primary_observation_count=EXCLUDED.primary_observation_count,
       related_observation_count=EXCLUDED.related_observation_count,
       source_class_snapshot=EXCLUDED.source_class_snapshot,
       observation_basis_snapshot=EXCLUDED.observation_basis_snapshot,
       upstream_origin_key_snapshot=EXCLUDED.upstream_origin_key_snapshot,
       semantic_contract_version_snapshot=EXCLUDED.semantic_contract_version_snapshot,
       acquisition_bases=EXCLUDED.acquisition_bases,
       time_precision_summary=EXCLUDED.time_precision_summary,
       updated_at=now()`,
    [
      input.entityId,
      input.source.sourceDefinitionId,
      revisionId,
      summary.state,
      summary.firstSeenTime,
      summary.firstSeenDate,
      summary.lastSeenTime,
      summary.lastSeenDate,
      summary.firstNodeReceivedAt,
      summary.lastNodeReceivedAt,
      summary.observationCount,
      summary.primaryObservationCount,
      summary.relatedObservationCount,
      input.source.sourceClass,
      input.source.observationBasis,
      input.source.upstreamOriginKey,
      input.source.semanticContractVersion,
      JSON.stringify(summary.acquisitionBases),
      summary.timePrecisionSummary,
    ],
  );

  return true;
}

export async function recomputeEntitySourcePresence(entityId: string): Promise<number> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`node7:${entityId}`]);

    const entity = await client.query<{ entity_type: string; entity_key: string }>(
      `SELECT entity_type,entity_key FROM technical_entity_registry WHERE id=$1`,
      [entityId],
    );
    const identity = entity.rows[0];
    if (!identity) throw new Error(`NODE-7 entity registry row not found: ${entityId}`);

    const observations = await client.query<ObservationHeadRow>(
      `SELECT head.current_revision_id AS observation_revision_id,
              head.state AS observation_state,
              head.entity_role,
              head.observed_time,
              head.observed_date::text,
              head.acquisition_basis,
              raw.received_at AS node_received_at,
              source.id AS source_definition_id,
              source.source_key,
              source.source_class,
              source.observation_basis,
              source.upstream_origin_key,
              source.semantic_contract_version
       FROM entity_observation_heads head
       JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
       JOIN raw_source_records raw ON raw.id=revision.raw_record_id
       JOIN source_definitions source ON source.id=head.source_definition_id
       WHERE head.entity_type=$1 AND head.entity_key=$2
       ORDER BY source.source_key,head.observation_key`,
      [identity.entity_type, identity.entity_key],
    );

    const groups = new Map<string, SourceGroup>();
    for (const row of observations.rows) {
      let group = groups.get(row.source_definition_id);
      if (!group) {
        group = { source: semanticSnapshot(row), observations: [] };
        groups.set(row.source_definition_id, group);
      }
      group.observations.push({
        revisionId: row.observation_revision_id,
        state: row.observation_state,
        role: row.entity_role,
        observedTime: row.observed_time?.toISOString() ?? null,
        observedDate: row.observed_date,
        nodeReceivedAt: row.node_received_at.toISOString(),
        acquisitionBasis: row.acquisition_basis,
      });
    }

    const previousSources = await client.query<PriorSourceRow>(
      `SELECT source.id AS source_definition_id,source.source_key,source.source_class,
              source.observation_basis,source.upstream_origin_key,source.semantic_contract_version
       FROM entity_source_presence_heads presence
       JOIN source_definitions source ON source.id=presence.source_definition_id
       WHERE presence.entity_id=$1`,
      [entityId],
    );
    for (const source of previousSources.rows) {
      if (!groups.has(source.source_definition_id)) {
        groups.set(source.source_definition_id, { source: semanticSnapshot(source), observations: [] });
      }
    }

    let written = 0;
    for (const group of [...groups.values()].sort((left, right) => left.source.sourceKey.localeCompare(right.source.sourceKey))) {
      if (await appendPresenceRevision({ client, entityId, ...group })) written += 1;
    }
    return written;
  });
}

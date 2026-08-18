import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";

const CHECKPOINT_KEY = "ENTITY_OBSERVATION_CURSOR";

async function ensureRegistryEntity(
  client: PoolClient,
  entityType: string,
  entityKey: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO technical_entity_registry(entity_type,entity_key)
     VALUES ($1,$2)
     ON CONFLICT (entity_type,entity_key) DO NOTHING
     RETURNING id`,
    [entityType, entityKey],
  );
  if (inserted.rows[0]?.id) return inserted.rows[0].id;

  const current = await client.query<{ id: string }>(
    `SELECT id FROM technical_entity_registry WHERE entity_type=$1 AND entity_key=$2`,
    [entityType, entityKey],
  );
  const id = current.rows[0]?.id;
  if (!id) throw new Error("NODE-7 entity registry lookup failed after conflict");
  return id;
}

export async function markEntityDirty(
  client: PoolClient,
  entityId: string,
  reasonCode: string,
): Promise<void> {
  await client.query(
    `INSERT INTO node7_dirty_entities(entity_id,reason_codes)
     VALUES ($1,jsonb_build_array($2::text))
     ON CONFLICT (entity_id) DO UPDATE SET
       dirty_since=LEAST(node7_dirty_entities.dirty_since,now()),
       dirty_revision=node7_dirty_entities.dirty_revision+1,
       reason_codes=EXCLUDED.reason_codes,
       available_at=LEAST(node7_dirty_entities.available_at,now()),
       attempt_count=0,
       last_failure_code=NULL,
       last_failure_message=NULL,
       updated_at=now()`,
    [entityId, reasonCode],
  );
}

export async function discoverEntityObservationRevisions(limit: number): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("NODE-7 discovery limit must be 1..5000");
  }

  return withTransaction(async (client) => {
    const checkpoint = await client.query<{
      last_revision_created_at: Date | null;
      last_revision_id: string | null;
    }>(
      `SELECT last_revision_created_at,last_revision_id
       FROM node7_projection_checkpoints
       WHERE projection_key=$1
       FOR UPDATE`,
      [CHECKPOINT_KEY],
    );
    const row = checkpoint.rows[0];
    if (!row) throw new Error("NODE-7 entity observation checkpoint is missing");

    const revisions = await client.query<{
      id: string;
      created_at: Date;
      entity_type: string;
      entity_key: string;
    }>(
      `SELECT id,created_at,entity_type,entity_key
       FROM entity_observation_revisions
       WHERE ($1::timestamptz IS NULL OR (created_at,id) > ($1::timestamptz,$2::uuid))
       ORDER BY created_at,id
       LIMIT $3`,
      [row.last_revision_created_at, row.last_revision_id, limit],
    );

    for (const revision of revisions.rows) {
      const entityId = await ensureRegistryEntity(client, revision.entity_type, revision.entity_key);
      await markEntityDirty(client, entityId, "ENTITY_OBSERVATION_REVISION");
    }

    const last = revisions.rows.at(-1);
    if (last) {
      await client.query(
        `UPDATE node7_projection_checkpoints
         SET last_revision_created_at=$2,last_revision_id=$3,revision=revision+1,updated_at=now()
         WHERE projection_key=$1`,
        [CHECKPOINT_KEY, last.created_at, last.id],
      );
    }

    return revisions.rows.length;
  });
}

export async function discoverSourceSemanticDrift(limit: number): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("NODE-7 semantic drift limit must be 1..5000");
  }
  const result = await pool.query<{ entity_id: string }>(
    `SELECT DISTINCT presence.entity_id
     FROM entity_source_presence_heads presence
     JOIN source_definitions source ON source.id=presence.source_definition_id
     WHERE presence.source_class_snapshot IS DISTINCT FROM source.source_class
        OR presence.observation_basis_snapshot IS DISTINCT FROM source.observation_basis
        OR presence.upstream_origin_key_snapshot IS DISTINCT FROM source.upstream_origin_key
        OR presence.semantic_contract_version_snapshot IS DISTINCT FROM source.semantic_contract_version
     ORDER BY presence.entity_id
     LIMIT $1`,
    [limit],
  );
  if (result.rows.length === 0) return 0;
  await withTransaction(async (client) => {
    for (const row of result.rows) await markEntityDirty(client, row.entity_id, "SOURCE_SEMANTIC_CHANGE");
  });
  return result.rows.length;
}

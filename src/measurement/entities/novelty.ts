import { pool, withTransaction } from "../../db/pool.js";
import { applyMeasurementFactCandidate } from "../projection/runtime.js";
import { makeCandidate } from "../projection/utils.js";

interface NoveltyRow {
  history_revision_id: string;
  entity_key: string;
  entity_type: string;
  first_seen_time: Date | null;
  first_seen_date: string | null;
  first_source_definition_id: string;
  first_source_key: string;
  revision_acquisition_basis:
    | "LIVE_INCREMENTAL"
    | "INITIAL_BOOTSTRAP"
    | "RECOVERY"
    | "HISTORICAL_BACKFILL"
    | "RESYNC"
    | "REPAIR"
    | "SNAPSHOT_RECONSTRUCTION";
  input_fingerprint: string;
  measurement_key:
    | "ioc.threatfox.first_seen_indicators"
    | "malware.malwarebazaar.first_seen_hashes";
  calculation_id: string;
}

export async function syncNoveltyFacts(limit = 100): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Invalid novelty batch limit");
  }

  const rows = await pool.query<NoveltyRow>(
    `SELECT h.current_revision_id AS history_revision_id,
            h.entity_key,h.entity_type,h.first_seen_time,h.first_seen_date::text,
            h.first_source_definition_id,source.source_key AS first_source_key,
            h.revision_acquisition_basis,history.input_fingerprint,
            CASE
              WHEN source.source_key='THREATFOX'
                AND h.entity_type IN ('IP','DOMAIN','URL','HASH')
                THEN 'ioc.threatfox.first_seen_indicators'
              WHEN source.source_key='MALWAREBAZAAR'
                AND h.entity_type='HASH'
                AND h.entity_key LIKE 'sha256:%'
                THEN 'malware.malwarebazaar.first_seen_hashes'
              ELSE NULL
            END AS measurement_key,
            CASE
              WHEN source.source_key='THREATFOX' THEN tf_head.active_calculation_id
              WHEN source.source_key='MALWAREBAZAAR' THEN mb_head.active_calculation_id
              ELSE NULL
            END AS calculation_id
     FROM entity_history_heads h
     JOIN entity_history_revisions history ON history.id=h.current_revision_id
     JOIN source_definitions source ON source.id=h.first_source_definition_id
     LEFT JOIN measurement_definition_heads tf_head
       ON tf_head.measurement_key='ioc.threatfox.first_seen_indicators'
     LEFT JOIN measurement_definition_heads mb_head
       ON mb_head.measurement_key='malware.malwarebazaar.first_seen_hashes'
     WHERE (
       (source.source_key='THREATFOX' AND h.entity_type IN ('IP','DOMAIN','URL','HASH'))
       OR (
         source.source_key='MALWAREBAZAAR'
         AND h.entity_type='HASH'
         AND h.entity_key LIKE 'sha256:%'
       )
     )
       AND NOT EXISTS (
         SELECT 1
         FROM entity_history_measurement_receipts receipt
         WHERE receipt.entity_history_revision_id=h.current_revision_id
           AND receipt.measurement_calculation_id=CASE
             WHEN source.source_key='THREATFOX' THEN tf_head.active_calculation_id
             ELSE mb_head.active_calculation_id
           END
       )
     ORDER BY history.calculated_at
     LIMIT $1`,
    [limit],
  );

  let processed = 0;
  for (const row of rows.rows) {
    if (!row.measurement_key || !row.calculation_id) continue;

    const candidate = makeCandidate({
      measurementKey: row.measurement_key,
      identity: { entityType: row.entity_type, entityKey: row.entity_key },
      factKind: "EVENT",
      eventTime: row.first_seen_time?.toISOString() ?? null,
      eventDate: row.first_seen_date,
      timePrecision: row.first_seen_date ? "DATE" : "INSTANT",
      numericValue: 1,
      entityKey: row.entity_key,
      entityType: row.entity_type,
      dimensions: {},
      acquisitionBasis: row.revision_acquisition_basis,
      sourceModelVersion: null,
      inputRole: "ENTITY_HISTORY",
      fingerprintMaterial: row.input_fingerprint,
    });

    await withTransaction(async (client) => {
      await applyMeasurementFactCandidate({
        client,
        calculationId: row.calculation_id,
        sourceDefinitionId: row.first_source_definition_id,
        candidate,
        reason: "ENTITY_HISTORY_CHANGED",
      });

      const head = await client.query<{ current_fact_id: string }>(
        `SELECT current_fact_id
         FROM measurement_fact_heads
         WHERE measurement_calculation_id=$1 AND fact_key=$2`,
        [row.calculation_id, candidate.factKey],
      );
      const factId = head.rows[0]?.current_fact_id;
      if (!factId) throw new Error("Novelty fact head missing after projection");

      await client.query(
        `INSERT INTO measurement_fact_inputs(
           measurement_fact_id,input_role,entity_history_revision_id
         ) VALUES ($1,'ENTITY_HISTORY',$2)
         ON CONFLICT DO NOTHING`,
        [factId, row.history_revision_id],
      );

      await client.query(
        `INSERT INTO entity_history_measurement_receipts(
           entity_history_revision_id,measurement_calculation_id
         ) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [row.history_revision_id, row.calculation_id],
      );
    });

    processed += 1;
  }

  return processed;
}

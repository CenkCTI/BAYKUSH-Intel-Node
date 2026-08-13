import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "../db/pool.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export async function handleMeasurementProvenanceApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  const match = url.pathname.match(
    /^\/v1\/techint\/provenance\/measurement\/([0-9a-f-]{36})$/i,
  );
  const revisionId = match?.[1];
  if (!revisionId) return false;

  const bucket = await pool.query<{
    id: string;
    measurement_calculation_id: string;
    bucket_start: Date;
    bucket_end: Date;
    calculated_at: Date;
    input_fingerprint: string;
    coverage_input_fingerprint: string;
    revision_number: number;
    measurement_key: string;
    contract_version: string;
    calculation_version: string;
  }>(
    `SELECT revision.id,revision.measurement_calculation_id,
            revision.bucket_start,revision.bucket_end,revision.calculated_at,
            revision.input_fingerprint,revision.coverage_input_fingerprint,
            revision.revision_number,definition.measurement_key,
            definition.contract_version,calculation.calculation_version
     FROM measurement_bucket_revisions revision
     JOIN measurement_definitions definition
       ON definition.id=revision.measurement_definition_id
     JOIN measurement_calculation_versions calculation
       ON calculation.id=revision.measurement_calculation_id
     WHERE revision.id=$1`,
    [revisionId],
  );

  const row = bucket.rows[0];
  if (!row) {
    send(response, 404, {
      apiVersion: "v1",
      generatedAt: new Date().toISOString(),
      data: null,
      error: { code: "INVALID_REQUEST", message: "Measurement revision not found" },
    });
    return true;
  }

  const facts = await pool.query(
    `WITH latest_at_calculation AS (
       SELECT DISTINCT ON (fact_key)
              id,fact_key,revision_number,fact_state,event_time,event_date,
              entity_key,entity_type,input_fingerprint,created_at
       FROM measurement_facts
       WHERE measurement_calculation_id=$1
         AND created_at <= $4
       ORDER BY fact_key,revision_number DESC
     ), eligible AS (
       SELECT *
       FROM latest_at_calculation
       WHERE fact_state='ACTIVE'
         AND (
           (event_time >= $2 AND event_time < $3)
           OR (event_date >= $2::date AND event_date < $3::date)
         )
     )
     SELECT eligible.*,
            input.input_role,input.raw_record_id,input.canonical_record_id,
            input.collection_run_id,input.entity_history_revision_id
     FROM eligible
     LEFT JOIN measurement_fact_inputs input
       ON input.measurement_fact_id=eligible.id
     ORDER BY eligible.fact_key,input.input_role
     LIMIT 100`,
    [
      row.measurement_calculation_id,
      row.bucket_start,
      row.bucket_end,
      row.calculated_at,
    ],
  );

  send(response, 200, {
    apiVersion: "v1",
    generatedAt: new Date().toISOString(),
    data: {
      measurement: {
        key: row.measurement_key,
        contractVersion: row.contract_version,
        calculationVersion: row.calculation_version,
      },
      revision: {
        id: row.id,
        revisionNumber: row.revision_number,
        calculatedAt: row.calculated_at.toISOString(),
        inputFingerprint: row.input_fingerprint,
        coverageInputFingerprint: row.coverage_input_fingerprint,
      },
      inputs: facts.rows,
    },
    meta: {
      limit: 100,
      knowledgeBoundary: row.calculated_at.toISOString(),
      note:
        "Fact revision is resolved at the bucket calculation knowledge boundary before event-time filtering; provider raw payloads are not redistributed.",
    },
  });
  return true;
}

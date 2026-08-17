/* eslint-disable @typescript-eslint/no-explicit-any -- persisted telemetry details are versioned JSON evidence. */
import { pool } from "../src/db/pool.js";
import { streamHealthyForRecovery } from "../src/recovery/repository.js";

async function main(): Promise<void> {
  const instance = process.env.NODE6_2_SOAK_STREAM_INSTANCE ?? "node62-soak-stream";
  const session = await pool.query<{ id: string; status: string }>(`SELECT id,status FROM stream_sessions WHERE runtime_instance_id=$1 ORDER BY created_at DESC LIMIT 1`, [instance]);
  const id = session.rows[0]?.id; if (!id) throw new Error(`No real RIPE Live session found for ${instance}`);
  const events = await pool.query<{ event_type: string; count: number }>(`SELECT event_type,count(*)::int count FROM stream_session_events WHERE stream_session_id=$1 GROUP BY event_type`, [id]);
  const telemetry = await pool.query<{ event_at: Date; details: any }>(`SELECT event_at,details FROM stream_session_events WHERE stream_session_id=$1 AND event_type='STREAM_TELEMETRY' ORDER BY event_at`, [id]);
  const forbidden = new Set(["PROVIDER_DISCONNECT", "BACKPRESSURE_LIMIT", "DB_UNAVAILABLE", "FORCED_TERMINATE"]);
  const failures = events.rows.filter((row) => forbidden.has(row.event_type) && row.count > 0);
  const samples = telemetry.rows.map((row) => ({ at: row.event_at.toISOString(), received: Number(row.details.receivedMessages), persisted: Number(row.details.persistedMessages), queue: Number(row.details.queueMessages) }));
  const result = { schemaVersion: "NODE6_2_LIVE_RECOVERY_SOAK_OPERATOR_V1", accepted: samples.length >= 9 && failures.length === 0, session: session.rows[0], sampleCount: samples.length, first: samples[0], last: samples.at(-1), failures, recoveryCurrentlyAllowed: await streamHealthyForRecovery() };
  console.dir(result, { depth: null }); if (!result.accepted) process.exitCode = 1;
}
try { await main(); } finally { await pool.end(); }

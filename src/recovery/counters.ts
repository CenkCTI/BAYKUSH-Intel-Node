import { pool } from "../db/pool.js";

export async function persistDecoderStateChangeCount(decoderRunId: string, stateChangeRecords: number): Promise<void> {
  if (!Number.isInteger(stateChangeRecords) || stateChangeRecords < 0) {
    throw new Error("Invalid decoder state-change record count");
  }
  const result = await pool.query(
    `UPDATE stream_recovery_decoder_runs
     SET state_change_records=$2
     WHERE id=$1 AND status='SUCCEEDED'`,
    [decoderRunId, stateChangeRecords],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error("Decoder state-change provenance run is unavailable");
}

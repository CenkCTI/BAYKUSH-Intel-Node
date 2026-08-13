# NODE-4 backfill operator runbook

Use `npm run node4:backfill -- plan SOURCE FROM TO` to inspect deterministic segments, then `queue` with the same arguments to persist a request. `status [REQUEST_ID]` reports bounded request state. `retry REQUEST_ID` deliberately requeues failed segments. `cancel REQUEST_ID` prevents queued future work; it does not delete immutable evidence already captured.

Run exactly one `BACKFILL` process by default. Keep the live scheduler/worker running: live work has claim priority. Provider credentials belong only in collector/backfill runtimes; the measurement runtime remains credential-free.

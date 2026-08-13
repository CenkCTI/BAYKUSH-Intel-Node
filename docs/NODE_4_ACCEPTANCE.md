# NODE-4 acceptance

Automated gates cover deterministic planning, NVD segment-local pagination, FIRST EPSS dated-artifact selection, bounded parsing, retry/lease state and immutable raw deduplication. PostgreSQL acceptance must additionally snapshot `source_checkpoints` before and after an executed backfill and assert byte-for-byte semantic equality, interrupt mid-page and resume, drain normalization/measurement, then run NODE-2G and NODE-3 final/security audits.

Live provider acceptance is recorded only when actually run. Unsupported source/provider intervals must remain explicit gaps.

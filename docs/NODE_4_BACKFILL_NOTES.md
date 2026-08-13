# NODE-4B Backfill Notes

The NODE-4 backfill design keeps historical progress separate from the live source cursor.

Implemented on this branch:

- additive historical segment ledger migration;
- NVD 24-hour interval planner;
- FIRST EPSS date-scoped segment planner;
- planner unit coverage.

Required acceptance before merge:

- historical work must not alter `source_checkpoints`;
- live collection remains higher priority;
- historical raw evidence keeps normal provenance and normalization;
- unsupported source history remains an explicit gap rather than a numeric zero.

# NODE-4 historical acquisition

The dedicated `BACKFILL` runtime claims one historical segment at a time. It yields whenever the same source has queued or running live collection. Segment leases are restart-safe; retryable failures use bounded backoff and terminal failures remain inspectable.

NVD uses fixed 24-hour last-modified windows with segment-local pagination state (`startIndex`, expected total, restart count). FIRST EPSS uses one allowlisted `epss_scores-YYYY-MM-DD.csv.gz` artifact per segment and preserves dataset/model hashes, the selected-population fingerprint and `EPSS_HIGH_SIGNAL_V1` profile. Historical references identify the actual dated artifact.

Captured records use ordinary `collection_runs` with purpose `HISTORICAL_BACKFILL`, immutable `raw_source_records`, and ordinary `normalization_jobs`. The backfill runtime never reads, writes, rewinds, or advances `source_checkpoints`.

CISA snapshot/dateAdded reconstruction, ThreatFox's bounded recent horizon, and MalwareBazaar's admitted recovery surface remain explicit availability/gap semantics. They are not provider-executed as arbitrary history and unavailable intervals are never converted to zero.

# NODE-2 Difference Register

This register records deliberate collection/mapping differences between the legacy CİTEM five-source collectors and BAYKUSH Intelligence Node. A listed difference is not permission to ignore unexplained parity failures. Any live difference that is not covered here or explicitly classified in parity evidence remains `UNCLASSIFIED` and blocks cutover.

## Classification meanings

- `SEMANTICALLY_EQUIVALENT` — different representation, same source meaning.
- `NODE_SUPERSET` — Node preserves additional source truth/provenance without changing source meaning.
- `INTENTIONAL_DIFFERENCE` — architecture intentionally changed for correctness/safety.
- `TEMPORAL_SKEW` — source changed between bounded live captures.
- `UNSUPPORTED_LEGACY` — Node safely preserves source material that the legacy mapper could not represent.
- `REGRESSION` — unexplained loss/corruption/semantic drift; blocks cutover.

## CISA KEV

### D-CISA-001 — Entry revision identity

**Classification:** `INTENTIONAL_DIFFERENCE`

Legacy CİTEM may bind observation revision identity to catalog release metadata. Node deliberately fingerprints the CVE entry payload without catalog-level release metadata so a new unchanged catalog release does not manufacture thousands of CVE revisions. Catalog release provenance remains in a raw manifest.

### D-CISA-002 — Retrieval channel

**Classification:** `SEMANTICALLY_EQUIVALENT`

Node prefers the official `cisagov/kev-data` GitHub mirror and can fall back to the canonical CISA feed. Both are the same upstream origin (`CISA_KEV`) and never count as independent corroboration.

### D-CISA-003 — Malformed snapshot policy

**Classification:** `INTENTIONAL_DIFFERENCE`

Node validates the complete bounded catalog fail-closed. It does not silently convert a malformed full catalog into an apparently complete partial catalog by skipping mandatory invalid entries.

## NVD CVE

### D-NVD-001 — Metrics preservation

**Classification:** `NODE_SUPERSET`

Node normalization v2 preserves the complete source-native NVD `metrics` container under neutral `nvd.metrics`. It does not force every metric family into a CVSS-only label.

### D-NVD-002 — CPE applicability

**Classification:** `NODE_SUPERSET`

Node preserves complete CPE applicability logic in immutable raw truth. Legacy flattened configuration summaries are not treated as equivalent to AND/OR/version applicability semantics.

### D-NVD-003 — Mirrored CISA fields

**Classification:** `INTENTIONAL_DIFFERENCE`

NVD fields that mirror CISA material remain NVD source material and are not promoted as a second independent CISA KEV observation/corroboration source.

### D-NVD-004 — Revision/version contract

**Classification:** `INTENTIONAL_DIFFERENCE`

Node keeps immutable source revisions and immutable normalization-version history. A semantic mapping correction creates a new normalization version rather than rewriting earlier canonical evidence.

## FIRST EPSS

### D-EPSS-001 — Retrieval surface

**Classification:** `INTENTIONAL_DIFFERENCE`

Legacy CİTEM uses the FIRST REST API. Node uses the official current daily compressed CSV artifact and validates the full bounded dataset before persisting the deterministic high-signal capture profile.

### D-EPSS-002 — Dataset provenance

**Classification:** `NODE_SUPERSET`

Node preserves model version, score date, compressed/decompressed size, artifact/content hashes, selected-population hash and explicit BAYKUSH capture-profile metadata. These fields do not change EPSS's semantic meaning.

### D-EPSS-003 — Capture-profile boundary

**Classification:** `SEMANTICALLY_EQUIVALENT`

Both legacy and Node implementations use the high-signal `minimum EPSS = 0.10`, maximum 2,500 population for operational capture. Absence from that bounded population is not score zero.

## ThreatFox

### D-TF-001 — Recovery model

**Classification:** `INTENTIONAL_DIFFERENCE`

Node uses a bounded one-to-seven-day overlapping snapshot-reconstruction strategy based on time since the last successful collection. Legacy CİTEM uses configured lookback plus provider-ID high-water behavior. Raw live counts are therefore not a parity contract.

### D-TF-002 — Unknown/invalid IOC type preservation

**Classification:** `NODE_SUPERSET`

Node retains the source report with explicit `UNMAPPED` or `INVALID_SOURCE_VALUE` normalization status instead of dropping useful provider reporting when a technical entity cannot be safely normalized.

### D-TF-003 — Defensive IOC normalizers

**Classification:** `UNSUPPORTED_LEGACY`

Node can conservatively normalize additional provider-emitted indicator shapes while preserving the source report as the primary evidence object. The existence of a normalizer is not a claim that ThreatFox currently emits that type.

### D-TF-004 — Query manifest

**Classification:** `NODE_SUPERSET`

Node preserves materially changed query/response provenance in a raw-only manifest. It normalizes to zero canonical intelligence records.

## MalwareBazaar

### D-MB-001 — Recent selector

**Classification:** `INTENTIONAL_DIFFERENCE`

Legacy CİTEM uses `get_recent&selector=100`; Node uses `get_recent&selector=time`, a rolling recent-additions time window. Count equality is therefore not a valid live parity test. Intersection by SHA-256 and critical source facts is the relevant comparison.

### D-MB-002 — Revision identity

**Classification:** `INTENTIONAL_DIFFERENCE`

Node raw identity is SHA-256 plus immutable payload fingerprint. Changed provider metadata creates a revision; overlapping query context is kept out of the sample payload so polling does not manufacture revisions.

### D-MB-003 — Additional metadata retention

**Classification:** `NODE_SUPERSET`

Node raw truth can preserve SHA3-384, similarity/structural hashes, Magika, TrID, code-signing metadata, nested provider intelligence and other additive fields. V1 canonicalization intentionally promotes only source fields with clear semantics.

### D-MB-004 — Tags

**Classification:** `INTENTIONAL_DIFFERENCE`

Legacy CİTEM may create generic TAG entities from MalwareBazaar tags. Node v1 retains tags as source facts rather than automatically promoting arbitrary provider labels into global canonical identity.

### D-MB-005 — Malware binary boundary

**Classification:** `INTENTIONAL_DIFFERENCE`

Node has no `get_file`, ZIP download, malware execution or sample-storage path. MalwareBazaar is admitted as a metadata source only.

## Cross-source differences

### D-X-001 — Internal schema identity

**Classification:** `SEMANTICALLY_EQUIVALENT`

CİTEM Technical Signal IDs, Node raw IDs, Node canonical evidence IDs and internal cursors are implementation details and are not parity keys. Parity uses upstream source identity and source-native critical facts.

### D-X-002 — Collection health

**Classification:** `INTENTIONAL_DIFFERENCE`

Node source health is operational state only. It is never projected as cyber activity, activity decline, threat level or evidence that a source observed zero events.

### D-X-003 — Bootstrap

**Classification:** `INTENTIONAL_DIFFERENCE`

Initial bootstrap is explicitly distinguished from later `LIVE_INCREMENTAL` collection. Bootstrap ingestion must not manufacture a current-activity spike in future NODE-3 measurements.

### D-X-004 — Collection authority

**Classification:** `INTENTIONAL_DIFFERENCE`

After NODE-2G operator acceptance, BAYKUSH Intelligence Node becomes the collection authority for these five public/global sources. Legacy CİTEM collectors remain preserved but paused for explicit operator-controlled rollback; automatic dual-authority fallback is prohibited.

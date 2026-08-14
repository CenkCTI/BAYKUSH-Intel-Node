# NODE-5 New-Source Measurement Contracts

## Scope

This slice adds measurement contracts and source projectors for the NODE-5 sources whose admission policy explicitly permits measurement projection. It does **not** add read-API routes or CİTEM UI integration.

## Permission boundary

| Source | Measurement projection | V1 measurement role |
|---|---:|---|
| `FEODO_TRACKER` | Yes | First newly retained C2 source identities observed during valid live collection |
| `SSLBL_CERTIFICATE` | Yes | First newly retained certificate identities observed during valid live collection |
| `GITHUB_ADVISORY_REVIEWED` | Yes | Reviewed advisory publications and live retained revisions |
| `CISA_ICS_CSAF` | Yes | OT advisory publications and live retained revisions |
| `MITRE_ATTACK_ENTERPRISE` | No | Context knowledge only |
| `JVN_IPEDIA` | No | Recent publication surface without admitted measurement coverage contract |
| `CERT_EU_SECURITY_ADVISORY` | No | Recent publication surface without admitted measurement coverage contract |
| `SIEMENS_PRODUCTCERT_CSAF` | No | Publication-only vendor source in this revision |

The measurement projector registry mirrors this permission boundary. A source with `measurementProjectionAllowed=false` has no NODE-5 measurement projector.

## V1 measurements

### Feodo Tracker

`ioc.feodo_tracker.new_records_observed`

This is deliberately a **Node observation-time** measurement. Feodo is collected as a current snapshot and does not provide the historical completeness needed to turn all retained `first_seen` values into an authoritative historical activity series. The metric counts first retained source identities seen during valid live scheduled collection. It does not count attacks, victims, infections, bot population, or exact upstream first appearance.

### SSLBL

`ioc.sslbl.certificate_listings_observed`

This is also deliberately a **Node observation-time** measurement. It counts first retained SHA1 certificate identities observed during valid live collection. It does not claim complete historical SSLBL listing activity or certificate compromise proof.

### GitHub Advisory Database — Reviewed

- `vulnerability.github_advisory.publications`
- `vulnerability.github_advisory.updates_observed`

Publications use the source `published_at` axis. Update observations use Node receive time and only count retained revisions after the first revision during valid live collection. The source population remains limited to GitHub `type=reviewed`; unreviewed NVD-derived and malware advisories remain excluded.

### CISA ICS CSAF

- `vulnerability.cisa_ics.advisory_publications`
- `vulnerability.cisa_ics.advisory_updates_observed`

Publications use the CSAF initial-release timestamp. Update observations use Node receive time and only count retained revisions after the first revision during valid live collection. These metrics describe advisory publication activity only, not exploitation, attacks, exposure, remediation priority, risk, or threat level.

## Invariants

1. Measurement contracts remain versioned and hash-protected by the existing NODE-3 registry.
2. Source-time measurements and Node-observation-time measurements remain separate.
3. Bootstrap, recovery and historical acquisition do not create live revision-observation spikes.
4. Snapshot-only Feodo/SSLBL sources do not gain fictional complete historical coverage in this slice.
5. Measurement-disallowed NODE-5 sources remain absent from the measurement projector registry.
6. No read API or CİTEM behavior changes are included here.

## Next slice

The next NODE-5 PR may expose these measurements through the existing coverage-aware historical read API, but only after this measurement slice is green. CİTEM Global View v2 remains a separate downstream PR.
